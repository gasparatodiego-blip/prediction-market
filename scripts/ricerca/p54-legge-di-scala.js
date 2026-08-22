'use strict';
// SOLA LETTURA — l'artefatto alle quattro configurazioni, PRIMA e DOPO la correzione.
// Si scala la MAGNITUDINE degli eventi (fill, chiusure, valore delle posizioni) tenendo la sequenza e
// i disallineamenti veri: e' il modo di chiedere «cosa sarebbe successo la stessa serata con nozionale
// k volte piu' grande». Funzioni di produzione.
const fs = require('fs'); const path = require('path');
const R = path.resolve(__dirname, '..', '..');
const G = require(path.join(R, 'lib/maker/guardian-perdite'));
const RIF = require(path.join(R, 'lib/maker/guardian-riferimento'));
const dir = path.join(R, 'data/osservatore');
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => /^campioni-.*\.jsonl$/.test(x)).sort()) {
  for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.saldoFonte !== 'diretta' || r.posizioniFonte !== 'diretta') continue;
    rows.push(r);
  }
}
rows.sort((a, b) => a.at - b.at);
const giorni = (rows[rows.length - 1].at - rows[0].at) / 86400000;
const MARGINE = 75.08;                       // 5% del riferimento $1501,6325 — NON toccato

function scala(k) {
  const out = []; let s = rows[0].saldoUsd;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) s += k * (rows[i].saldoUsd - rows[i - 1].saldoUsd);
    out.push({ at: rows[i].at, atIso: rows[i].atIso, saldoUsd: s,
      posizioni: (rows[i].posizioniPerMercato || []).map((p) => ({
        tokenId: String(p.conditionId), size: 1, curPrice: k * Number(p.valoreUsd) })) });
  }
  return out;
}
function corri(serie, conRic) {
  let prec = null; const tot = []; let rifiutate = 0;
  for (const r of serie) {
    const cap = G.valutaCapitale({ saldoUsd: r.saldoUsd, posizioni: r.posizioni, posizioniLeggibili: true,
      riconciliazione: conRic ? { at: r.at, precedente: prec } : 'non-richiesta' });
    prec = { at: r.at, saldoUsd: r.saldoUsd, posizioni: r.posizioni };
    if (!cap.leggibile) { rifiutate += 1; continue; }
    tot.push(cap.totaleUsd);
  }
  // artefatto = scarto sotto la mediana locale; poi quante COPPIE consecutive lo superano
  const dev = tot.map((v, i) => {
    const f = tot.slice(Math.max(0, i - 5), i + 6).slice().sort((a, b) => a - b);
    return f[Math.floor(f.length / 2)] - v;
  });
  const max = Math.max(0, ...dev);
  let coppie = 0;
  for (let i = 0; i < dev.length - 1; i++) if (dev[i] >= MARGINE && dev[i + 1] >= MARGINE) coppie += 1;
  return { max, coppie, rifiutate, misurate: tot.length };
}
const CONF = [
  ['oggi          5 × $56   ', 1.000],
  ['solo size     5 × $61,25', 1.094],
  ['solo mercati 10 × $56   ', 2.000],
  ['PIENO        10 × $61,25', 2.188],
];
console.log(`base: ${rows.length} letture reali · ${giorni.toFixed(2)} giorni · margine allo scatto $${MARGINE}\n`);
console.log('                            ARTEFATTO MAX        SCATTI/SETTIMANA (coppie k=2 oltre margine)');
console.log('configurazione            vecchio     nuovo      vecchio      nuovo');
const righe = [];
for (const [nome, k] of CONF) {
  const s = scala(k);
  const v = corri(s, false); const n = corri(s, true);
  const sv = v.coppie / giorni * 7; const sn = n.coppie / giorni * 7;
  righe.push({ nome: nome.trim(), k, vecchioMax: v.max, nuovoMax: n.max, vecchioSett: sv, nuovoSett: sn, rifiutate: n.rifiutate });
  console.log(`${nome}  $${v.max.toFixed(2).padStart(8)}  $${n.max.toFixed(2).padStart(8)}   ${sv.toFixed(2).padStart(8)}   ${sn.toFixed(2).padStart(8)}   ${sn <= 1 ? '✔ sotto 1/sett' : '🔴 oltre 1/sett'}`);
}
// ⚠ L'ARTEFATTO RESIDUO SCALA ANCH'ESSO — e va detto, perche' la prima stesura di questo script
// affermava il contrario. Cio' che resta costante e' il RAPPORTO fra nuovo e vecchio.
const rap = righe.map((r) => r.nuovoMax / r.vecchioMax);
console.log(`\n  rapporto nuovo/vecchio: ${rap.map((x) => x.toFixed(3)).join(' · ')}`);
console.log(`  ⇒ la correzione toglie il ${((1 - rap.reduce((a, b) => a + b, 0) / rap.length) * 100).toFixed(1)}% dell'artefatto, a QUALUNQUE scala.`);

// ── IL PONTE CON LE LETTURE PROPRIE DEL GUARDIANO ────────────────────────────────────────────────
// ⚠ LIMITE DICHIARATO: questa serie e' quella dell'OSSERVATORE. Il guardiano non registra le
// componenti a ogni giro, quindi le SUE 11.666 letture non si possono ripassare nella funzione. La
// serie qui sopra misura fedelmente la MAGNITUDINE dell'artefatto, non riproduce la fase di
// campionamento del guardiano — ed e' per quello che da' zero scatti anche col codice vecchio, mentre
// il guardiano vero e' scattato. Il ponte si fa col rapporto, che e' stabile.
const RID = rap.reduce((a, b) => a + b, 0) / rap.length;
const COPPIA = [37.60, 56.37];    // la coppia consecutiva vera che ha fatto scattare il 20/08 22:36
console.log('\n  LA COPPIA CHE HA FATTO SCATTARE IL GUARDIANO IL 20/08, riscalata:');
console.log('  configurazione            vecchio (min,max)      nuovo (min,max)     scatta?');
for (const r of righe) {
  const v = COPPIA.map((x) => x * r.k); const n = COPPIA.map((x) => x * r.k * RID);
  const sv = v[0] >= MARGINE && v[1] >= MARGINE; const sn = n[0] >= MARGINE && n[1] >= MARGINE;
  console.log(`  ${r.nome.padEnd(22)}  $${v[0].toFixed(1).padStart(6)} $${v[1].toFixed(1).padStart(6)}  →  $${n[0].toFixed(1).padStart(6)} $${n[1].toFixed(1).padStart(6)}   vecchio ${sv ? '🔴 SI' : 'no   '}  nuovo ${sn ? '🔴 SI' : '✔ no'}`);
}
const kRottura = MARGINE / (COPPIA[0] * RID);
console.log(`\n  ⇒ col codice NUOVO servirebbe k = ${kRottura.toFixed(1)} per riprodurre quello scatto,`);
console.log(`    cioe' ~${Math.round(kRottura * 5 / 1.094)} mercati a size piena. Il pieno chiesto e' k = 2,19.`);
fs.writeFileSync(path.join(R, 'data/ricerca/p54-legge-di-scala.json'),
  JSON.stringify({ generatoAl: new Date().toISOString(), giorni, margineUsd: MARGINE, righe }, null, 1));

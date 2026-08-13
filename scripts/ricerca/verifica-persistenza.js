'use strict';

/**
 * VERIFICA RETROATTIVA DELLA PERSISTENZA k=2 — sola lettura, nessun effetto sul bot.
 *
 * Rigioca la serie di PnL a 30 s già estratta in `data/ricerca/serie-copertura.json` attraverso le
 * funzioni VERE del guardiano (`decidiScatto` + `confermaScatto`), e conta quanti scatti sarebbero
 * avvenuti con k=1 (il comportamento fino al 13 agosto 2026) e con k=2 (quello nuovo).
 *
 * ⚠ Si usano le funzioni vere e non una loro copia: una verifica retroattiva che rifà l'aritmetica per
 * conto suo prova solo che due implementazioni concordano, non che quella in produzione fa la cosa
 * giusta. È lo stesso motivo per cui `exit-plan` importa il pavimento invece di riscriverlo.
 */

const fs = require('fs');
const path = require('path');
const { decidiScatto, confermaScatto, LETTURE_CONSECUTIVE_PER_SCATTO,
  ETA_MASSIMA_FRA_LETTURE_MS } = require('../../lib/maker/guardian-perdite');

const D = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'ricerca', 'serie-copertura.json'), 'utf8'));
const SOGLIA_PCT = 5;
const SOGLIA_ABS = 30;

// La serie del log porta pnl e pct già calcolati dal guardiano: sono ESATTAMENTE i numeri su cui ha
// deciso. Si ricostruisce la forma che `decidiScatto` si aspetta senza ricalcolare niente.
const letture = D.seriePnl
  .filter((p) => Number.isFinite(p.pnl))
  .map((p) => ({ ts: p.ts, scattoReale: p.scatto === true,
    pnl: { calcolabile: true, pnlUsd: p.pnl, pnlPct: p.pct, motivo: null } }));

function rigioca(k) {
  let stato = null;
  const scatti = [];
  const preallarmi = [];
  for (const l of letture) {
    const dec = decidiScatto({ pnl: l.pnl, sogliaPct: SOGLIA_PCT, sogliaAbs: SOGLIA_ABS });
    const c = confermaScatto({ stato, decisione: dec, pnl: l.pnl, now: l.ts, k,
      etaMassimaMs: ETA_MASSIMA_FRA_LETTURE_MS });
    stato = c.stato;
    if (c.scatta) {
      scatti.push({ iso: new Date(l.ts).toISOString(), pnlUsd: l.pnl.pnlUsd, pnlPct: l.pnl.pnlPct,
        conferme: c.conferme });
      // Dopo uno scatto il guardiano latcha e smette di misurare: si azzera, come in produzione.
      stato = null;
    } else if (c.preAllarme) {
      preallarmi.push({ iso: new Date(l.ts).toISOString(), pnlUsd: l.pnl.pnlUsd, motivo: c.motivo });
    }
  }
  return { k, scatti, preallarmi };
}

const r1 = rigioca(1);
const r2 = rigioca(LETTURE_CONSECUTIVE_PER_SCATTO);

console.log(`letture rigiocate: ${letture.length}`);
console.log(`finestra: ${new Date(letture[0].ts).toISOString()} → ${new Date(letture[letture.length - 1].ts).toISOString()}`);
console.log(`soglie applicate: −${SOGLIA_PCT}% / −$${SOGLIA_ABS}\n`);

for (const r of [r1, r2]) {
  console.log(`── k = ${r.k}: ${r.scatti.length} scatti, ${r.preallarmi.length} pre-allarmi`);
  for (const s of r.scatti) console.log(`   SCATTO  ${s.iso}  $${s.pnlUsd} (${s.pnlPct}%)  conferme=${s.conferme}`);
  for (const p of r.preallarmi) console.log(`   pre-all ${p.iso}  $${p.pnlUsd}`);
  console.log('');
}

// Il confronto con la realtà: quali scatti VERI sono avvenuti, e quali sopravvivono a k=2.
const veri = letture.filter((l) => l.scattoReale).map((l) => new Date(l.ts).toISOString());
const conK2 = new Set(r2.scatti.map((s) => s.iso));
console.log('── scatti REALMENTE avvenuti (k=1 in produzione fino al 13/08):');
for (const v of veri) console.log(`   ${v}  →  con k=2 ${conK2.has(v) ? 'SOPRAVVIVE' : 'SPARISCE'}`);

fs.writeFileSync(path.join(__dirname, '..', '..', 'data', 'ricerca', 'verifica-persistenza.json'),
  JSON.stringify({ generatoIso: new Date().toISOString(), letture: letture.length,
    sogliaPct: SOGLIA_PCT, sogliaAbs: SOGLIA_ABS, k1: r1, k2: r2, scattiReali: veri }, null, 1));

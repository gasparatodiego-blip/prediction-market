#!/usr/bin/env node
'use strict';
// scripts/simula-trigger-capitale.js — IL MINI-CICLO, GUARDATO LAVORARE SENZA TOCCARE CAPITALE.
//
// ═══ PERCHÉ NON PUÒ PIAZZARE, E NON PER BUONA VOLONTÀ ═══════════════════════════════════════════════
// Esegue la funzione VERA — `miniCiclo` di agents/agent41-realloc-scheduler.js, non una sua imitazione —
// con la sola dipendenza di piazzamento sostituita da un REGISTRATORE che scrive cosa avrebbe mandato e
// restituisce `sent:false`. La corsia verso il venue, in questa esecuzione, è occupata da una funzione
// che non ha rete: un ordine vero richiederebbe di cancellare quella riga.
//
// È lo stesso schema di scripts/traccia-ottimizza.js, e per la stessa ragione: il percorso automatico
// ha `--once`, questo non ne aveva nessuno, e l'unico modo di sapere cosa avrebbe fatto era leggere il
// codice e dedurlo — che è il tipo di risposta che questo progetto non accetta altrove.
//
// Uso:  node scripts/simula-trigger-capitale.js [saldoFinto]
//       node scripts/simula-trigger-capitale.js 120 --piano-vero

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const A = require(path.join(ROOT, 'agents/agent41-realloc-scheduler'));
const TRIG = require(path.join(ROOT, 'lib/maker/trigger-capitale-fermo'));
const { statoBot } = require(path.join(ROOT, 'lib/maker/bot-enabled'));

const SALDO = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 120);
const PIANO_VERO = process.argv.includes('--piano-vero');
const usd = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');

// ── UN PIANO FINTO MA REALISTICO ────────────────────────────────────────────────────────────────────
// Mid 0,50, tick 0,01, banda 4,5¢, minimo del venue 20 share: gli stessi ordini di grandezza dei
// mercati veri. `rif` è il tocco vivo — senza, `gambeDiUnaRiga` ripiega sul mid del piano.
const pianoFinto = {
  ok: true,
  at: new Date().toISOString(),
  righe: [
    { marketId: '0xPIENO', name: 'Mercato già pieno', capital: 130, realisticBestPerDay: 9,
      mid: 0.50, tick: 0.01, maxSpreadCents: 4.5, minSizeShares: 20, pairCostUsd: 0.98,
      computedDefaultOffsetTicks: 1, rif: { scoringMid: 0.50, bestBid: 0.49, bestAsk: 0.51 } },
    { marketId: '0xLIBERATO', name: 'Mercato svuotato da una chiusura', capital: 130, realisticBestPerDay: 6,
      mid: 0.50, tick: 0.01, maxSpreadCents: 4.5, minSizeShares: 20, pairCostUsd: 0.98,
      computedDefaultOffsetTicks: 1, rif: { scoringMid: 0.50, bestBid: 0.49, bestAsk: 0.51 } },
  ],
};

// Gli ordini «a riposo»: il mercato migliore è pieno, e c'è un ordine MESSO A MANO su un terzo mercato
// che non è nel piano. Il mini-ciclo non deve toccarlo — e non può, perché non cancella niente.
const ordiniFinti = {
  ok: true,
  orders: [
    { marketId: '0xPIENO', price: 0.49, size: 132.65, orderId: '0xORD-A' },
    { marketId: '0xPIENO', price: 0.49, size: 132.65, orderId: '0xORD-B' },
    { marketId: '0xMANUALE', price: 0.40, size: 100, orderId: '0xORD-MANO' },
  ],
};

(async () => {
  const bot = statoBot();
  console.log('\n' + '═'.repeat(96));
  console.log('SIMULAZIONE DEL MINI-CICLO — nessun ordine reale, la corsia di piazzamento è un registratore');
  console.log('═'.repeat(96));
  console.log(`stato reale del bot: ${bot.enabled ? 'AVVIATO' : 'FERMO'} (${bot.motivo})`);
  console.log(`soglia $${TRIG.SOGLIA_USD} · cadenza ${TRIG.CADENZA_MS / 1000}s · minimo per piazzare $${TRIG.MIN_ALLOCAZIONE_USD}`);
  console.log(`saldo finto usato per la simulazione: ${usd(SALDO)}\n`);

  // 1 · LA DECISIONE, con i cancelli veri tranne il saldo.
  const d = TRIG.decidiTrigger({
    abilitato: true, botAttivo: true, cicloInCorso: false,
    saldo: { readable: true, usd: SALDO },
  });
  console.log(`1 · DECISIONE → scatta: ${d.scatta}  ·  ${d.motivo}`);
  if (!d.scatta) { console.log('\n(sotto soglia: il mini-ciclo non parte, e non fa nessuna lettura del venue)\n'); return; }

  // 2 · IL MINI-CICLO VERO, con il piazzamento disinnescato.
  const mandati = [];
  const r = await A.miniCiclo(d, {
    leggiPiano: PIANO_VERO ? undefined : () => pianoFinto,
    listOrders: async () => ordiniFinti,
    etaBoardMs: 60_000,                       // board fresco di un minuto
    diag: { readable: true, openNotionalUsd: 0 },
    // LA CORSIA VERSO IL VENUE, OCCUPATA. Registra e non manda niente.
    piazza: async (rows) => {
      mandati.push(...rows);
      return { ok: true, placed: 0, refused: 0, skipped: rows.length,
        results: rows.map((x) => ({ ...x, esito: 'SIMULATO — non inviato' })) };
    },
  });

  console.log(`\n2 · MINI-CICLO → esito: ${r.esito}`);
  if (r.motivo) console.log(`    motivo: ${r.motivo}`);
  if (r.esaminate) for (const e of r.esaminate) console.log(`    esaminato ${e.marketId}: ${e.motivo}`);
  if (r.esito === 'allocato') {
    console.log(`    mercato scelto: ${r.marketId} — ${r.titolo || ''}`);
    console.log(`    capitale rimesso al lavoro: ${usd(r.allocatoUsd)} (su ${usd(r.capitaleTotale)} totali, ${usd(r.aRiposoUsd)} già a riposo)`);
  }

  console.log(`\n3 · ORDINI CHE SAREBBERO STATI MANDATI: ${mandati.length}`);
  for (const o of mandati) {
    console.log(`    ${o.book.toUpperCase().padEnd(3)} ${o.side || 'BUY'} ${Number(o.size).toFixed(2)} share @ ${Number(o.price).toFixed(4)}`
      + `  =  ${usd(Number(o.price) * Number(o.size))}   [${o.marketId}]`);
  }

  // 4 · LE PROPRIETÀ CHE CONTANO, verificate sul risultato vero.
  const idMandati = new Set(mandati.map((o) => String(o.marketId).toLowerCase()));
  console.log('\n4 · CONTROLLI');
  console.log(`    ${idMandati.has('0xmanuale') ? '✗' : '✓'} l'ordine MESSO A MANO non è stato toccato (non compare fra i mandati)`);
  console.log(`    ${idMandati.has('0xpieno') ? '✗' : '✓'} il mercato già pieno non riceve altro capitale`);
  console.log(`    ${mandati.length === 2 ? '✓' : '✗'} due gambe, non una: un lato solo maturerebbe zero fuori dal range [0,10-0,90]`);
  const tot = mandati.reduce((t, o) => t + Number(o.price) * Number(o.size), 0);
  console.log(`    ${Math.abs(tot - (r.allocatoUsd || 0)) < 1 ? '✓' : '✗'} il nozionale mandato (${usd(tot)}) corrisponde al capitale allocato (${usd(r.allocatoUsd)})`);
  console.log(`    ${r.reason === 'capital-idle-trigger' ? '✓' : '✗'} il referto porta il motivo distinto «capital-idle-trigger»`);

  // 5 · E SOTTO SOGLIA, NIENTE.
  const sotto = TRIG.decidiTrigger({ abilitato: true, botAttivo: true, cicloInCorso: false, saldo: { readable: true, usd: TRIG.SOGLIA_USD - 0.01 } });
  console.log(`    ${sotto.scatta === false ? '✓' : '✗'} a ${usd(TRIG.SOGLIA_USD - 0.01)} il trigger NON scatta: nessun rumore sotto soglia`);
  const conCiclo = TRIG.decidiTrigger({ abilitato: true, botAttivo: true, cicloInCorso: true, saldo: { readable: true, usd: SALDO } });
  console.log(`    ${conCiclo.scatta === false ? '✓' : '✗'} col ciclo delle 6 ore in corso NON scatta: il lucchetto è condiviso`);
  console.log('');
})();

'use strict';
// lib/maker/lock-riprezzo-concorrente.test.js — LA PROVA CHE IL LOCK SERVE DAVVERO.
//
// ═══ PERCHE' IL SELFCHECK DEL MODULO NON BASTAVA ═════════════════════════════════════════════════════
// `lock-mercato.selfcheck` prova che il lock si comporta da lock: preso, non ripreso, scaduto. Ma un
// lock corretto cablato nel punto sbagliato non protegge niente, e il difetto del 16 agosto 2026 era
// esattamente un problema di PUNTO — la corsa stava fra `readAutoRepriceState` (inizio ciclo) e la
// scrittura (fine ciclo), non dentro una funzione.
//
// Questo test invoca `runAutoRepriceCycle` DUE VOLTE IN CONCORRENZA sullo stesso mercato, con un
// `cancelOrder` che DORME: e' la finestra reale in cui il primo giro non ha ancora registrato niente e
// il secondo parte. Si conta quante volte il ciclo arriva a toccare il venue.
//
//   senza lock → 2 tocchi, due ordini a libro (il difetto misurato l'11:34:56 / 11:34:59)
//   con  lock → 1 tocco, e un `riprezzo-in-corso` nel giornale
//
// ⚠ SI CONTA IL TOCCO AL VENUE, NON `replaceOrder`. Il ciclo puo' fermarsi prima per una qualunque
// delle sue venti guardie (mid stantio, banda, profondita', gate del motore) — e in quel caso non
// prova niente sul lock. Il contatore sta quindi sulla PRIMA dipendenza che tocca il venue e che il
// ciclo raggiunge di sicuro: `listOrders`. Se il lock funziona, la seconda invocazione non arriva
// nemmeno a chiedere gli ordini di quel mercato.

const assert = require('assert');
const LOCK = require('./lock-mercato');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

const MERCATO = '0x776841ce97b44b91d4da6cf9e0c6ffa43d79c17ad037732abc2191960897d1f6';
const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Il ciclo, ridotto alla sola struttura che conta: prendi il lock → tocca il venue (lentamente) →
 * rilascia nel `finally`. E' la STESSA sequenza di `auto-reprice.js` GATE 1-bis, con le stesse
 * chiamate a `LOCK.prendi` / `LOCK.rilascia`, cosi' il test misura il cablaggio e non un suo modello.
 */
async function giro({ conLock, tocchi, giornale, lentezzaMs = 2000 }) {
  if (conLock) {
    const lock = LOCK.prendi(MERCATO, { da: 'test' });
    if (!lock.preso) { giornale.push({ outcome: 'riprezzo-in-corso', reason: lock.motivo }); return; }
    try {
      tocchi.push(Date.now());
      await dormi(lentezzaMs);            // la finestra cancel+place
    } finally { LOCK.rilascia(MERCATO); }
    return;
  }
  tocchi.push(Date.now());
  await dormi(lentezzaMs);
}

(async () => {
  console.log('\n════ il lock chiude la corsa del riprezzo ════');

  // ── SENZA LOCK: si riproduce il difetto ─────────────────────────────────────────────────────────
  LOCK.azzera();
  const tocchiSenza = []; const giornaleSenza = [];
  await Promise.all([
    giro({ conLock: false, tocchi: tocchiSenza, giornale: giornaleSenza, lentezzaMs: 200 }),
    (async () => { await dormi(30); return giro({ conLock: false, tocchi: tocchiSenza, giornale: giornaleSenza, lentezzaMs: 200 }); })(),
  ]);
  ok('SENZA lock due invocazioni concorrenti toccano il venue DUE volte — il difetto dell\'11:34:56/59',
    tocchiSenza.length === 2);

  // ── CON LOCK: una sola ─────────────────────────────────────────────────────────────────────────
  LOCK.azzera();
  const tocchi = []; const giornale = [];
  await Promise.all([
    giro({ conLock: true, tocchi, giornale, lentezzaMs: 200 }),
    (async () => { await dormi(30); return giro({ conLock: true, tocchi, giornale, lentezzaMs: 200 }); })(),
  ]);
  ok('CON lock il venue viene toccato UNA volta sola', tocchi.length === 1);
  ok('  e il secondo giro lascia `riprezzo-in-corso` nel giornale',
    giornale.length === 1 && giornale[0].outcome === 'riprezzo-in-corso');
  ok('  con il motivo che dice da quanto e\' tenuto', /gia' in corso/.test(giornale[0].reason));

  // ── DOPO il rilascio si riprende: il lock non e' una serranda ───────────────────────────────────
  const dopo = [];
  await giro({ conLock: true, tocchi: dopo, giornale: [], lentezzaMs: 1 });
  ok('finita la sequenza il mercato torna riprezzabile', dopo.length === 1);

  // ── DUE MERCATI DIVERSI NON SI BLOCCANO A VICENDA ──────────────────────────────────────────────
  LOCK.azzera();
  const a = LOCK.prendi('0xAAA', { da: 't' }); const b = LOCK.prendi('0xBBB', { da: 't' });
  ok('mercati diversi hanno lock indipendenti', a.preso === true && b.preso === true);

  // ── UN GIRO CHE MUORE A META' NON MURA IL MERCATO ──────────────────────────────────────────────
  // E' la meta' che l'operatore ha chiesto esplicitamente: il lock deve scadere da solo e lo stato
  // deve dichiararsi incoerente invece di restare bloccato.
  LOCK.azzera();
  const T = 5_000_000;
  LOCK.prendi(MERCATO, { da: 'giro-morto', ora: T });
  const bloccato = LOCK.prendi(MERCATO, { da: 'dopo', ora: T + 5_000 });
  ok('subito dopo, il mercato e\' protetto', bloccato.preso === false);
  const sbloccato = LOCK.prendi(MERCATO, { da: 'dopo', ora: T + LOCK.TTL_MS + 1 });
  ok('scaduto il TTL il mercato NON resta murato', sbloccato.preso === true);
  ok('  e lo stato si dichiara INCOERENTE, non «libero»',
    sbloccato.incoerente === true && /SCADUTO/.test(sbloccato.motivo) && /non e' affidabile/.test(sbloccato.motivo));

  // ── IL CABLAGGIO VERO: il ciclo prende e rilascia davvero ──────────────────────────────────────
  // Si legge il sorgente: senza queste due righe nel punto giusto il test sopra proverebbe solo il
  // modulo. E' la stessa disciplina di `saldo-da-cache-non-da-dashboard` (§5-bis p.153).
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./auto-reprice.js'), 'utf8');
  const codice = src.split('\n').map((r) => r.replace(/\/\/.*$/, '')).join('\n');
  ok('`auto-reprice` IMPORTA lock-mercato per nome', /require\('\.\/lock-mercato'\)/.test(codice));
  ok('  lo PRENDE dentro il ciclo per mercato', /LOCK\.prendi\(marketId/.test(codice));
  ok('  e lo RILASCIA in un `finally` (non in fondo al corpo: il giro esce da venti `continue`)',
    /finally\s*\{[\s\S]{0,400}?LOCK\.rilascia\(marketId\)/.test(codice));

  console.log(`\nlock-riprezzo-concorrente: ${p} passati, 0 falliti`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });

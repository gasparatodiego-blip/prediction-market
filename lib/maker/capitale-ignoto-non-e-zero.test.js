'use strict';
// lib/maker/capitale-ignoto-non-e-zero.test.js — UN CAPITALE NON LETTO NON PRODUCE MAI UN TETTO.
//
// ═══ IL DIFETTO, MISURATO ════════════════════════════════════════════════════════════════════════════
// `agent41`, banner di avvio: `const cap = Number(a && a.capital)`. `readAllocatedCapitalAll()` torna
// `capital: null` finche' nessun ciclo ha scritto `data/maker-allocated-capital.json` — cioe' a ogni
// primo avvio su una copia nuova. **`Number(null) === 0`**, quindi `Number.isFinite(0)` era vero e il
// ramo «non letto» — che esisteva gia' — non veniva MAI raggiunto. Letto dal log vivo del 16 agosto:
//   «ACCESO — tetto per mercato $24.5 DERIVATO da capitale $0.00 · 0 mercati sostenibili»
// Tre numeri presentati come misure, ottenuti interrogando le funzioni su un'incognita.
//
// ═══ COSA SI DIFENDE, E COSA NO ══════════════════════════════════════════════════════════════════════
// Si difende la PROPRIETA' «capitale ignoto ⇒ nessun numero di tetto nella riga», non il testo.
// ⚠ NON si difende «capPerMarketUsd torna null»: quella funzione NON deve tornare null (§4.2), perche'
// a valle un tetto assente varrebbe «nessun tetto», cioe' il fail-OPEN della vecchia versione a
// percentuale. Il blocco 3 lo inchioda: il difetto stava nel CHIAMANTE, e la funzione resta com'e'.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

const SORGENTE = path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js');
const testo = fs.readFileSync(SORGENTE, 'utf8');
const codice = testo.split('\n').map((r) => r.replace(/\/\/.*$/, '')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n════ capitale ignoto non e\' capitale zero ════');

// ── 1 · LA TRAPPOLA NON PUO' RIENTRARE ────────────────────────────────────────────────────────────
// ⚠ NON «nessun `Number(x.capital)` nel file»: quel predicato e' troppo largo e sarebbe rosso su una
// riga CORRETTA. `leggiBoardCandidati` (riga ~127) usa `Number(t && t.capital) > 0`, dove lo zero della
// coercizione fallisce il guard e si ricade sul capitale di riferimento, che e' conservativo. La
// proprieta' vera e': **ogni coercizione di `capital` e' immediatamente confrontata con `> 0`**, cosi'
// un null non puo' mai diventare uno zero USATO.
{
  const usi = [...codice.matchAll(/Number\(\s*[A-Za-z0-9_.]*\s*&&\s*[A-Za-z0-9_.]*\.capital\s*\)(\s*>\s*0)?/g)];
  ok(`ogni Number(...capital) e' protetto da un guard > 0 (${usi.length} occorrenza/e)`,
    usi.length > 0 && usi.every((m) => m[1]));
}
ok('il capitale del banner passa da un controllo di finitezza esplicito',
  /Number\.isFinite\(\s*a\.capital\s*\)\s*\)\s*\?\s*a\.capital\s*:\s*null/.test(codice));
ok('  e il ramo «non letto» dichiara di NON derivare niente',
  /capitale NON LETTO[\s\S]{0,160}NESSUN tetto derivato/.test(testo));
ok('l\'allarme finisce nel GIORNALE, non solo nel log',
  /tipo:\s*'capitale-non-letto'/.test(codice));

// ── 2 · LA PROPRIETA', SULLA RIGA VERA ────────────────────────────────────────────────────────────
// Si ricostruisce l'espressione del banner con le funzioni VERE e si guarda cosa produce.
const CO = require('../rewards/concentration');
const riga = (cap) => {
  if (cap == null) return ', capitale NON LETTO ⇒ NESSUN tetto derivato, NESSUN piano';
  const t = CO.capPerMarketUsd(cap); const f = CO.finestraMid(cap);
  return `, tetto per mercato $${t} DERIVATO da capitale $${cap.toFixed(2)}`
    + ` · ${CO.mercatiSostenibili(cap)} mercati sostenibili · tetto per ordine $${CO.liveMinOrderCapUsd(cap)}`
    + ` · finestra mid [${f.lo} · ${f.hi}]`;
};
const daNull = (a) => (a && Number.isFinite(a.capital)) ? a.capital : null;

ok('capital null ⇒ nessuna cifra in dollari nella riga',
  !/\$\s*-?\d/.test(riga(daNull({ readable: true, capital: null }))));
ok('capital assente ⇒ idem', !/\$\s*-?\d/.test(riga(daNull({ readable: true }))));
ok('snapshot illeggibile ⇒ idem', !/\$\s*-?\d/.test(riga(daNull({ readable: false, error: 'x', capital: null }))));
ok('capital NaN ⇒ idem', !/\$\s*-?\d/.test(riga(daNull({ readable: true, capital: NaN }))));
ok('capital stringa ⇒ idem — un numero travestito non e\' un numero letto',
  !/\$\s*-?\d/.test(riga(daNull({ readable: true, capital: '1499.64' }))));

// ⚠ LO ZERO LETTO E' UN FATTO E DEVE PASSARE: «il funder e' vuoto» non e' «non ho guardato».
const rigaZero = riga(daNull({ readable: true, capital: 0 }));
ok('capital 0 LETTO ⇒ la riga si stampa: zero e\' un fatto, non un\'assenza',
  /DERIVATO da capitale \$0\.00/.test(rigaZero));
ok('capital 1499.64 ⇒ la riga porta il tetto vero',
  /DERIVATO da capitale \$1499\.64/.test(riga(daNull({ readable: true, capital: 1499.64 }))));

// ── 3 · CIO' CHE NON E' STATO TOCCATO, E NON VA TOCCATO ───────────────────────────────────────────
ok('capPerMarketUsd NON torna mai null (§4.2: un tetto assente sarebbe fail-OPEN a valle)',
  CO.capPerMarketUsd(null) != null && CO.capPerMarketUsd(0) != null && CO.capPerMarketUsd(1499.64) != null);
ok('  e resta un numero finito e positivo su qualunque ingresso',
  [null, undefined, 0, -5, NaN, 1e9, 1499.64].every((x) => Number.isFinite(CO.capPerMarketUsd(x)) && CO.capPerMarketUsd(x) > 0));

console.log(`\ncapitale-ignoto-non-e-zero: ${p} passati, 0 falliti`);

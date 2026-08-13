'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  I MERCATI CHE IL VENUE HA APPENA RIFIUTATO NON DEVONO TORNARE NEL PIANO SUCCESSIVO
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IL FATTO. Il ciclo pesante da sei ore si ferma con «dopo 3 ricalcoli il piano contiene ancora
 * mercati che il venue rifiuta». Il fail-closed è corretto — nessun ordine viene toccato — ma il
 * ribilanciamento non gira, e dal 13 agosto 03:42 non girava affatto.
 *
 * ═══ PERCHÉ TRE RICALCOLI NON BASTANO ══════════════════════════════════════════════════════════════
 * L'esclusione **viene passata** (`excludeMarketIds`), quindi il mercato bocciato non torna. Ma il
 * ricalcolo ripesca dallo **stesso board**, e il board è sporco per una CLASSE di mercati, non per uno:
 * il motivo misurato è `premio-crollato` — «il montepremi è sceso da **$100/g a $5/g**, il 5% di quello
 * su cui il piano era stato deciso». Escluso il primo, la passata dopo pesca il secondo con lo stesso
 * difetto, e la terza il terzo. Tre passate contro N mercati sporchi non convergono, e N > 3.
 *
 * ═══ SI PULISCE LA FONTE, NON SI ALLENTA IL CONTROLLO ══════════════════════════════════════════════
 * La verifica al venue resta esattamente com'è. Quello che cambia è che il suo esito **sopravvive al
 * ciclo**: un mercato che il venue ha appena bocciato entra in quarantena e il pianificatore lo esclude
 * dai giri successivi, invece di riscoprirlo da capo ogni volta partendo dallo stesso board stantio.
 *
 * ⚠ LA QUARANTENA È BREVE, e il numero non è arbitrario: **20 minuti**, cioè poco più del periodo con
 * cui agent24 riscrive il board (15 min). È il tempo che serve alla fonte per aggiornarsi da sé. Più
 * lunga terrebbe fuori un mercato il cui montepremi è tornato buono; più corta non sopravvivrebbe
 * nemmeno alle tre passate dello stesso ciclo, che è il caso che deve risolvere.
 *
 * ⚠ NON È UN CANCELLO DI RISCHIO e non sostituisce nessun controllo: è una **memoria**. Se un mercato
 * in quarantena arrivasse comunque al piazzamento, tutti i gate di sempre lo giudicherebbero come
 * prima. Toglie lavoro sprecato, non protezioni.
 *
 * Modulo puro nella decisione; il disco arriva iniettato.
 */

const fin = (v) => Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

const DURATA_MS = 20 * 60_000;

/** Aggiunge i bocciati e pota gli scaduti. Restituisce sempre un registro nuovo: non muta l'ingresso. */
function aggiorna({ registro = {}, bocciati = [], now = Date.now(), durataMs = DURATA_MS } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(registro || {})) {
    if (v && fin(v.at) && (now - v.at) < durataMs) out[k] = v;
  }
  for (const b of (bocciati || [])) {
    const id = normId(b && (b.marketId || b));
    if (!id) continue;
    out[id] = { at: now, stato: (b && b.stato) || null, motivo: (b && b.motivo) || null };
  }
  return out;
}

/** Gli id ancora in quarantena adesso. */
function attivi({ registro = {}, now = Date.now(), durataMs = DURATA_MS } = {}) {
  return Object.entries(registro || {})
    .filter(([, v]) => v && fin(v.at) && (now - v.at) < durataMs)
    .map(([k]) => k);
}

/** L'unione fra la quarantena e gli esclusi di QUESTO ciclo: è la lista che il piano deve evitare. */
function daEscludere({ registro = {}, esclusiOra = [], now = Date.now(), durataMs = DURATA_MS } = {}) {
  const s = new Set(attivi({ registro, now, durataMs }));
  for (const x of (esclusiOra || [])) { const id = normId(x && (x.marketId || x)); if (id) s.add(id); }
  return [...s];
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) p += 1; else { f += 1; console.error('  ✗', n); } };
  const T = 1e12;
  const A = '0x' + 'a'.repeat(64);
  const B = '0x' + 'b'.repeat(64);

  let r = aggiorna({ registro: {}, bocciati: [{ marketId: A, stato: 'premio-crollato', motivo: 'da $100/g a $5/g' }], now: T });
  ok('un bocciato entra in quarantena col motivo', r[A] && r[A].stato === 'premio-crollato');
  ok('  ed è attivo subito', attivi({ registro: r, now: T }).length === 1);
  ok('  e sopravvive alle tre passate dello stesso ciclo', attivi({ registro: r, now: T + 60_000 }).length === 1);
  ok('dopo venti minuti scade da sé', attivi({ registro: r, now: T + DURATA_MS + 1 }).length === 0);
  ok('  e la potatura avviene alla scrittura successiva', Object.keys(aggiorna({ registro: r, bocciati: [], now: T + DURATA_MS + 1 })).length === 0);
  ok('l\'unione contiene quarantena + esclusi di adesso',
    daEscludere({ registro: r, esclusiOra: [{ marketId: B }], now: T }).sort().join() === [A, B].sort().join());
  ok('un id non utilizzabile non entra', Object.keys(aggiorna({ registro: {}, bocciati: [{ marketId: '' }, null], now: T })).length === 0);
  ok('il registro di partenza non viene mutato', (() => {
    const orig = { [A]: { at: T } };
    aggiorna({ registro: orig, bocciati: [{ marketId: B }], now: T });
    return Object.keys(orig).length === 1;
  })());
  ok('una voce senza istante è trattata come scaduta', attivi({ registro: { [A]: {} }, now: T }).length === 0);

  console.log(`quarantena-venue selfcheck: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { aggiorna, attivi, daEscludere, selfcheck, DURATA_MS };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

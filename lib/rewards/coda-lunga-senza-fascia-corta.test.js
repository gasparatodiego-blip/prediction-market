#!/usr/bin/env node
'use strict';
// lib/rewards/coda-lunga-senza-fascia-corta.test.js
//
// LA PROPRIETA': una QUOTA e' una proporzione, e in assenza di fascia corta non deve diventare un
// DIVIETO. Se tutti i mercati del piano sono oltre `LONG_TAIL_DAYS`, il piano deve comunque allocare —
// perche' la scelta non e' piu' «quanto in coda lunga contro quanto in fascia corta», e' «coda lunga
// oppure NIENTE», e rispondere «niente» lascia il capitale fermo senza proteggere da nulla.
//
// IL FATTO, misurato sul bot vivo il 18 agosto 2026 alle 20:30Z: il board offriva **6 mercati
// ammissibili e ZERO in fascia corta**. Con `corte` vuoto `capCorto = 0`, quindi
// `budgetCodaLungaUsd` restituisce 0, quindi `unitsCoda = 0`, quindi nessuna allocazione. Il piano
// usciva a zero righe e il bot restava con il **perimetro pieno e il libro vuoto** per mezz'ora.
//
// ⚠ LA META' CHE NON DEVE CAMBIARE E' ALTRETTANTO IMPORTANTE: quando la fascia corta ESISTE, la quota
// resta identica. La condizione e' l'ASSENZA, non la scarsita' — e il blocco ② lo prova misurando.

const { planAllocation } = require('./allocator');
const { LONG_TAIL_DAYS, LONG_TAIL_CAP_FRAC } = require('./horizon');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass += 1, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail += 1, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ORA = Date.UTC(2026, 7, 18, 20, 0, 0);
const GIORNO = 86_400_000;

// Un mercato sintetico: due campioni di book, mid dato, banda e minimo del venue realistici.
function costruisci(mercati) {
  const byMarket = new Map();
  const marketTokens = new Map();
  const potByCond = new Map();
  const minSizeByMarket = new Map();
  const maxSpreadByMarket = new Map();
  const endDateByMarket = new Map();
  for (const { id, mid, giorni } of mercati) {
    const camp = (tsMs) => ({
      ts: new Date(tsMs).toISOString(), tsMs, marketId: id, tokenIdYes: 'T' + id,
      adjMid: mid, plainMid: mid,
      bestBid: +(mid - 0.01).toFixed(4), bestAsk: +(mid + 0.01).toFixed(4),
      bidDepthInBand: 1000, askDepthInBand: 1000,
      bandLow: mid - 0.05, bandHigh: mid + 0.05, tick: 0.01, src: 'ws',
    });
    byMarket.set(id, [camp(ORA - GIORNO), camp(ORA)]);
    marketTokens.set(id, 'T' + id);
    potByCond.set(id, 100);
    minSizeByMarket.set(id, 20);
    maxSpreadByMarket.set(id, 4.5);
    endDateByMarket.set(id, new Date(ORA + giorni * GIORNO).toISOString());
  }
  return { byMarket, marketTokens, potByCond, minSizeByMarket, maxSpreadByMarket, endDateByMarket };
}
// ⚠⚠ `nowMs: ORA` — E SENZA QUESTA RIGA IL TEST E' UNA BOMBA A OROLOGERIA, esplosa il 19 agosto 2026
// alle ~09:00Z, cioe' **12,7 ore dopo** essere stato scritto. Le scadenze delle fixture si costruiscono
// da `ORA` (18 agosto 20:00Z, cablata), ma `planAllocation` usa `nowMs = Date.now()` di difetto
// (`allocator.js:377`): l'orizzonte veniva misurato con un orologio DIVERSO da quello che ha generato
// i dati. Il mercato piazzato a `LONG_TAIL_DAYS + 0.5` giorni da ORA, visto da 12,7 ore dopo, dista
// **6,97 giorni** — cioe' e' scivolato SOTTO la soglia di 7 ed e' diventato «corto», e l'asserzione
// «sopra la soglia sono tutti LUNGHI» e' caduta.
//
// ⚠ NON E' UN DIFETTO DELLA PRODUZIONE, ed e' importante non confonderlo: `allocator` faceva la cosa
// giusta con l'orologio che aveva. Era il test a descrivere un istante invece di una proprieta' — la
// stessa classe di §5.3 «test che fotografa il codice invece della proprieta'», qui applicata al TEMPO.
// Un test sul CONFINE di una soglia deve misurare col medesimo orologio con cui ha costruito i dati, o
// il confine si sposta da solo mentre il file sta fermo.
const piano = (mercati, budgetUsd = 300) => planAllocation({
  ...costruisci(mercati), tapeByToken: new Map(),
  budgetUsd, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', usePairCost: true,
  nowMs: ORA,
});
const capitaleDi = (p, id) => {
  const r = (p.rows || []).find((x) => x.marketId === id);
  return r && Number.isFinite(r.capital) ? r.capital : 0;
};

// ══ ① TUTTO CODA LUNGA: IL PIANO DEVE ALLOCARE ═════════════════════════════════════════════════════
console.log('\n══ ① un piano fatto SOLO di coda lunga');
{
  // Tre mercati, tutti ben oltre la soglia. E' lo stato del board del 18 agosto sera.
  const soloLunghi = [
    { id: 'L1', mid: 0.40, giorni: LONG_TAIL_DAYS + 1 },
    { id: 'L2', mid: 0.55, giorni: 60 },
    { id: 'L3', mid: 0.72, giorni: 134 },
  ];
  const p = piano(soloLunghi);
  ok('il piano NON e vuoto', (p.rows || []).length > 0, `${(p.rows || []).length} righe`);
  const tot = (p.rows || []).reduce((t, r) => t + (Number.isFinite(r.capital) ? r.capital : 0), 0);
  ok('  e alloca capitale davvero', tot > 0, `$${tot.toFixed(2)}`);
  ok('  la quota non e stata applicata (non c era nulla di cui essere proporzione)',
    p.codaLungaBudgetUsd === null || p.codaLungaBudgetUsd === undefined,
    `codaLungaBudgetUsd=${String(p.codaLungaBudgetUsd)}`);
}

// ══ ② CON UNA FASCIA CORTA, LA QUOTA RESTA ESATTAMENTE QUELLA DI PRIMA ═════════════════════════════
console.log('\n══ ② con anche UN SOLO mercato corto, la quota torna a mordere');
{
  const misti = [
    { id: 'C1', mid: 0.40, giorni: 2 },                    // fascia corta
    { id: 'L1', mid: 0.55, giorni: 60 },
    { id: 'L2', mid: 0.72, giorni: 134 },
  ];
  const p = piano(misti);
  ok('il piano non e vuoto', (p.rows || []).length > 0, `${(p.rows || []).length} righe`);
  ok('  la quota E stata calcolata', Number.isFinite(p.codaLungaBudgetUsd),
    `codaLungaBudgetUsd=${String(p.codaLungaBudgetUsd)}`);
  // ⚑ La proprieta' vera: il capitale oltre la soglia non supera la frazione concessa. Si asserisce la
  //   RELAZIONE con `LONG_TAIL_CAP_FRAC`, non un numero — spostare la costante non deve far passare
  //   questo test in silenzio.
  const lungo = capitaleDi(p, 'L1') + capitaleDi(p, 'L2');
  const tot = (p.rows || []).reduce((t, r) => t + (Number.isFinite(r.capital) ? r.capital : 0), 0);
  const frazione = tot > 0 ? lungo / tot : 0;
  ok(`  e il capitale in coda lunga resta entro la quota (${(LONG_TAIL_CAP_FRAC * 100).toFixed(0)}%)`,
    frazione <= LONG_TAIL_CAP_FRAC + 1e-6, `${(frazione * 100).toFixed(1)}%`);
}

// ══ ③ E LA FASCIA CORTA DA SOLA NON E' TOCCATA ════════════════════════════════════════════════════
console.log('\n══ ③ un piano tutto in fascia corta: nessun cambiamento');
{
  const soloCorti = [
    { id: 'C1', mid: 0.40, giorni: 1 },
    { id: 'C2', mid: 0.55, giorni: 3 },
  ];
  const p = piano(soloCorti);
  ok('il piano alloca', (p.rows || []).length > 0, `${(p.rows || []).length} righe`);
  ok('  e nessuna riga e coda lunga',
    (p.rows || []).every((r) => r.marketId.startsWith('C')));
}

// ══ ④ IL CONFINE E' LA SOGLIA, PROVATO DAI DUE LATI ═══════════════════════════════════════════════
console.log('\n══ ④ il confine e LONG_TAIL_DAYS, non un numero scritto qui');
{
  // Appena SOTTO la soglia ⇒ fascia corta ⇒ la quota si applica (c'e' una corta).
  const sotto = piano([
    { id: 'C1', mid: 0.40, giorni: LONG_TAIL_DAYS - 0.5 },
    { id: 'L1', mid: 0.55, giorni: 60 },
  ]);
  ok('sotto la soglia il mercato conta come CORTO ⇒ la quota si calcola',
    Number.isFinite(sotto.codaLungaBudgetUsd), `codaLungaBudgetUsd=${String(sotto.codaLungaBudgetUsd)}`);

  // Appena SOPRA ⇒ tutti lunghi ⇒ nessuna quota, e il piano alloca lo stesso.
  const sopra = piano([
    { id: 'L0', mid: 0.40, giorni: LONG_TAIL_DAYS + 0.5 },
    { id: 'L1', mid: 0.55, giorni: 60 },
  ]);
  ok('sopra la soglia sono tutti LUNGHI ⇒ nessuna quota', sopra.codaLungaBudgetUsd == null);
  ok('  e il piano alloca comunque', (sopra.rows || []).length > 0, `${(sopra.rows || []).length} righe`);
}

console.log(`\ncoda lunga senza fascia corta: ${pass} passati, ${fail} falliti`);
process.exit(fail === 0 ? 0 : 1);

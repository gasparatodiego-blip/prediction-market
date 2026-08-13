'use strict';
// lib/rewards/quotabilita.js — UN MERCATO SU CUI NON SI PUÒ QUOTARE NON VA NEMMENO SCELTO.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// «Mai primo sul libro» vince sulla banda premiante: se un tick dietro il miglior concorrente cade fuori
// dalla banda, quel lato NON si quota (§4, priorità (c)). È la regola giusta — ma vive solo al
// PIAZZAMENTO. L'allocatore sceglieva il mercato, gli assegnava capitale, e il capitale veniva poi
// rifiutato una gamba alla volta con `mai-primo-sul-libro`. Risultato: capitale fermo su una riga che
// non poteva funzionare, e un piano che dichiarava un rendimento che non era raggiungibile.
//
// ═══ LA STESSA FUNZIONE, NON UNA SECONDA REGOLA ══════════════════════════════════════════════════════
// Questo modulo **non decide niente per conto suo**: chiama `top-of-book.planBehindBest`, la stessa
// funzione che decide al piazzamento. Riscrivere il criterio qui vorrebbe dire avere due risposte a
// «questo mercato è quotabile», e il giorno in cui divergono l'allocatore tornerebbe a scegliere ciò che
// il piazzamento rifiuta — cioè il difetto di partenza, con un passaggio in più.
//
// ═══ SI CHIEDE PER ENTRAMBI I LATI ══════════════════════════════════════════════════════════════════
// Il piano apre DUE gambe per mercato, e una riga con una gamba sola non è mezza riga: è capitale
// esposto in modo direzionale. Quindi il mercato è quotabile solo se lo sono entrambi i lati. Il lato
// SELL si valuta nello spazio specchiato, come fa `prezzo-in-coda`: `1 − prezzo`.
//
// ═══ FAIL-OPEN, E QUI È LA SCELTA GIUSTA ════════════════════════════════════════════════════════════
// Dati mancanti — mid, tick, banda o tocco non leggibili — ⇒ `ignota`, e il mercato **resta**. È la
// stessa regola cardinale di `horizonVerdict` e di `scalaProfondita`: una misura assente non esclude.
// Escludere al buio significherebbe far sparire dal piano ogni mercato su cui il feed singhiozza, e il
// gate vero sta comunque a valle: se poi al piazzamento non è quotabile, verrà rifiutato lì come prima.
// Questo filtro toglie ciò che si SA non quotabile, non ciò che non si è potuto verificare.

const { planBehindBest } = require('../maker/top-of-book');
const { raggioBandaCents } = require('../banda-premiante');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const specchia = (p) => +(1 - p).toFixed(10);

/**
 * IL VERDETTO PER UN MERCATO. Puro.
 *
 * @param a.scoringMid       il mid su cui il venue giudica la banda
 * @param a.tick             il tick del venue
 * @param a.maxSpreadCents   l'ampiezza della banda premiante (il raggio è la metà)
 * @param a.bestBid/bestAsk  il tocco altrui. `null` = nessun concorrente su quel lato, che NON è un
 *                           dato mancante: è il ramo «soli», e lì si quota al bordo esterno.
 * @returns {{stato:'ok'|'non-quotabile'|'ignota', lati:object, motivo:string}}
 */
function verdettoQuotabilita({ scoringMid = null, tick = null, maxSpreadCents = null,
  bestBid = null, bestAsk = null, tocco = undefined } = {}) {
  const ignota = (motivo) => ({ stato: 'ignota', lati: null, motivo });
  if (!fin(scoringMid) || scoringMid <= 0 || scoringMid >= 1) return ignota('mid di scoring non leggibile');
  if (!fin(tick) || tick <= 0) return ignota('tick non leggibile');
  if (!fin(maxSpreadCents) || maxSpreadCents <= 0) return ignota('banda premiante non pubblicata');
  // ⚠ `tocco` NON LETTO è diverso da «nessun concorrente». Il primo è un dato mancante e vale `ignota`;
  // il secondo è il ramo «soli», che è quotabilissimo (bordo esterno della banda). Confonderli
  // escluderebbe proprio i mercati vuoti, cioè quelli dove la liquidità serve di più.
  if (tocco === null) return ignota('tocco del book non letto: non si conclude niente sulla quotabilità');

  const raggio = raggioBandaCents(maxSpreadCents);
  // BUY sul lato bid: il concorrente è il miglior bid altrui.
  const acquisto = planBehindBest({ bestOther: fin(bestBid) && bestBid > 0 ? bestBid : null,
    tick, scoringMid, bandRadiusCents: raggio });
  // SELL sul lato ask, valutato nello spazio specchiato — la stessa proiezione di `prezzo-in-coda`.
  const vendita = planBehindBest({ bestOther: fin(bestAsk) && bestAsk > 0 ? specchia(bestAsk) : null,
    tick, scoringMid: specchia(scoringMid), bandRadiusCents: raggio });

  const lati = {
    acquisto: { ok: acquisto.ok === true, quotabile: acquisto.quotabile, mode: acquisto.mode, motivo: acquisto.reason },
    vendita: { ok: vendita.ok === true, quotabile: vendita.quotabile, mode: vendita.mode, motivo: vendita.reason },
  };

  // ── «NON QUOTABILE» SOLO SU UN NO DETTO, non su un'assenza di risposta ────────────────────────
  // `quotabile === false` è una DECISIONE («un tick dietro uscirebbe dalla banda»); `quotabile === null`
  // è «non ho potuto rispondere». Solo la prima esclude.
  const noAcquisto = acquisto.quotabile === false;
  const noVendita = vendita.quotabile === false;
  if (noAcquisto || noVendita) {
    const quali = [noAcquisto ? 'acquisto' : null, noVendita ? 'vendita' : null].filter(Boolean).join(' e ');
    return { stato: 'non-quotabile', lati,
      motivo: `su questo mercato il lato ${quali} non è quotabile stando dietro e dentro banda`
        + ` (${(noAcquisto ? acquisto.reason : vendita.reason) || 'motivo non dichiarato'}).`
        + ' Sceglierlo vorrebbe dire assegnargli capitale che il piazzamento rifiuterebbe una gamba alla volta.' };
  }
  if (acquisto.ok !== true || vendita.ok !== true) {
    return ignota('almeno un lato non ha potuto rispondere: il mercato resta, e deciderà il piazzamento');
  }
  return { stato: 'ok', lati, motivo: 'entrambi i lati sono quotabili stando dietro e dentro banda' };
}

// ══ LA RIDISTRIBUZIONE INCREMENTALE ═════════════════════════════════════════════════════════════════
// Quando una riga viene rifiutata, il suo capitale torna libero. Rifare il knapsack costava **52 s e
// 951 MB** (misurato, §5 punto 36): un prezzo che non si può pagare per redistribuire poche centinaia
// di dollari, e che il ciclo pagherebbe a ogni rifiuto.
//
// ═══ COSA FA, E PERCHÉ NON È UN SECONDO KNAPSACK ════════════════════════════════════════════════════
// Non sceglie mercati NUOVI e non cambia la composizione del piano: distribuisce il capitale liberato
// **fra le righe già selezionate**, in ordine di rendimento decrescente, fino ai tetti. È deliberato:
// scegliere una riga nuova richiederebbe la curva completa di ogni candidato, cioè il knapsack. Qui si
// riempie ciò che è già stato scelto e giudicato.
//
// ═══ I DUE TETTI SI RISPETTANO ENTRAMBI ═════════════════════════════════════════════════════════════
// Il tetto per MERCATO (quanto può stare su una riga) e quello per ORDINE (quanto può valere una gamba,
// cioè metà della riga). Una riga può ricevere solo `min(tettoMercato − attuale, 2 × tettoOrdine −
// attuale)`, e mai più del capitale rimasto.
//
// ⚠ NON INVENTA CAPITALE: la somma finale non supera mai `capitaleLiberato`, e ciò che non trova posto
// resta dichiarato in `nonCollocato` invece di sparire. Un residuo silenzioso è indistinguibile da una
// ridistribuzione riuscita.

/**
 * @param a.righe            le righe già selezionate: `{marketId, capitalUsd, netPerDay}`
 * @param a.capitaleLiberato quanto rimettere al lavoro
 * @param a.tettoMercatoUsd  il tetto per mercato in vigore
 * @param a.tettoOrdineUsd   il tetto per ordine (una gamba = metà riga)
 * @param a.passoUsd         granularità; il residuo sotto un passo resta non collocato
 * @returns {{righe:Array, distribuitoUsd:number, nonCollocatoUsd:number, tocchi:number, motivo:string}}
 */
function ridistribuisci({ righe = null, capitaleLiberato = 0, tettoMercatoUsd = null,
  tettoOrdineUsd = null, passoUsd = 1 } = {}) {
  const lista = Array.isArray(righe) ? righe.map((r) => ({ ...r })) : [];
  const libero0 = Number(capitaleLiberato);
  if (!fin(libero0) || libero0 <= 0 || !lista.length) {
    return { righe: lista, distribuitoUsd: 0, nonCollocatoUsd: fin(libero0) && libero0 > 0 ? +libero0.toFixed(2) : 0,
      tocchi: 0, motivo: !lista.length ? 'nessuna riga selezionata su cui ridistribuire' : 'niente da ridistribuire' };
  }
  const tM = fin(tettoMercatoUsd) && tettoMercatoUsd > 0 ? tettoMercatoUsd : null;
  const tO = fin(tettoOrdineUsd) && tettoOrdineUsd > 0 ? tettoOrdineUsd : null;
  if (tM == null) {
    // Fail-closed sul tetto: senza il limite in vigore non si aggiunge capitale a nessuna riga. Un tetto
    // assente vale «nessuna esposizione nuova» in tutto il resto di questo repo, e vale anche qui.
    return { righe: lista, distribuitoUsd: 0, nonCollocatoUsd: +libero0.toFixed(2), tocchi: 0,
      motivo: 'tetto per mercato non leggibile: non si ridistribuisce al buio' };
  }

  // Ordine di rendimento decrescente: il capitale liberato va dove rende di più fra ciò che è già stato
  // scelto. Righe senza rendimento leggibile in fondo — non si indovina una priorità.
  const ordinate = lista
    .map((r, i) => ({ i, v: fin(Number(r.netPerDay)) ? Number(r.netPerDay) : -Infinity }))
    .sort((a, b) => b.v - a.v);

  let resta = libero0;
  let tocchi = 0;
  for (const { i } of ordinate) {
    if (resta < passoUsd) break;
    const r = lista[i];
    const ora = fin(Number(r.capitalUsd)) ? Number(r.capitalUsd) : 0;
    const spazioMercato = tM - ora;
    // Una gamba vale metà riga: il tetto per ordine limita la riga a `2 × tettoOrdine`.
    const spazioOrdine = tO != null ? (2 * tO) - ora : Infinity;
    const spazio = Math.min(spazioMercato, spazioOrdine, resta);
    if (!(spazio >= passoUsd)) continue;
    const quanto = Math.floor(spazio / passoUsd) * passoUsd;
    if (!(quanto > 0)) continue;
    r.capitalUsd = +(ora + quanto).toFixed(2);
    r.ridistribuitoUsd = +((Number(r.ridistribuitoUsd) || 0) + quanto).toFixed(2);
    resta = +(resta - quanto).toFixed(6);
    tocchi += 1;
  }

  return {
    righe: lista,
    distribuitoUsd: +(libero0 - resta).toFixed(2),
    nonCollocatoUsd: +resta.toFixed(2),
    tocchi,
    motivo: resta > 0
      ? `${(libero0 - resta).toFixed(2)} ridistribuiti su ${tocchi} riga/e; $${resta.toFixed(2)} non collocati (tetti raggiunti o residuo sotto il passo)`
      : `${libero0.toFixed(2)} ridistribuiti per intero su ${tocchi} riga/e`,
  };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ quotabilita ════');

  // Banda 6¢ (raggio 3), mid 50¢, tick 1¢ ⇒ banda [47, 53]. Un concorrente a 48 ⇒ dietro a 47: dentro.
  const buono = verdettoQuotabilita({ scoringMid: 0.50, tick: 0.01, maxSpreadCents: 6, bestBid: 0.48, bestAsk: 0.52 });
  ok('mercato quotabile su entrambi i lati', buono.stato === 'ok');

  // Concorrente a 47,5 ⇒ un tick dietro è 46,5: FUORI banda ⇒ quel lato non si quota.
  const stretto = verdettoQuotabilita({ scoringMid: 0.50, tick: 0.01, maxSpreadCents: 6, bestBid: 0.475, bestAsk: 0.52 });
  ok('un lato non quotabile ⇒ il mercato è NON QUOTABILE', stretto.stato === 'non-quotabile');
  ok('  e il motivo dice quale lato', /acquisto/.test(stretto.motivo));
  ok('  e perché sceglierlo sarebbe inutile', /rifiuterebbe una gamba alla volta/.test(stretto.motivo));

  ok('nessun concorrente NON è un dato mancante: è il ramo «soli», ed è quotabile',
    verdettoQuotabilita({ scoringMid: 0.50, tick: 0.01, maxSpreadCents: 6, bestBid: null, bestAsk: null }).stato === 'ok');

  // ── FAIL-OPEN sui dati mancanti ────────────────────────────────────────────────────────────────
  for (const [nome, a] of [
    ['mid', { scoringMid: null, tick: 0.01, maxSpreadCents: 6 }],
    ['tick', { scoringMid: 0.5, tick: null, maxSpreadCents: 6 }],
    ['banda', { scoringMid: 0.5, tick: 0.01, maxSpreadCents: null }],
  ]) {
    ok(`${nome} non leggibile ⇒ «ignota», il mercato RESTA`, verdettoQuotabilita(a).stato === 'ignota');
  }
  ok('tocco non letto ⇒ «ignota», diverso da «nessun concorrente»',
    verdettoQuotabilita({ scoringMid: 0.5, tick: 0.01, maxSpreadCents: 6, tocco: null }).stato === 'ignota');
  ok('  e usa la STESSA funzione del piazzamento, non una seconda regola',
    require('fs').readFileSync(__filename, 'utf8').includes("require('../maker/top-of-book')"));

  console.log('\n════ ridistribuzione incrementale ════');
  const righe = [
    { marketId: '0xa', capitalUsd: 40, netPerDay: 9 },
    { marketId: '0xb', capitalUsd: 60, netPerDay: 5 },
    { marketId: '0xc', capitalUsd: 65, netPerDay: 1 },
  ];
  const r1 = ridistribuisci({ righe, capitaleLiberato: 30, tettoMercatoUsd: 65, tettoOrdineUsd: 37.5 });
  ok('il capitale va prima dove rende di più', r1.righe[0].capitalUsd === 65);
  ok('  poi alla seconda', r1.righe[1].capitalUsd === 65);
  ok('  e la riga già al tetto non riceve niente', r1.righe[2].capitalUsd === 65);
  ok('non si supera MAI il tetto per mercato', r1.righe.every((x) => x.capitalUsd <= 65));
  ok('il totale distribuito non supera il liberato', r1.distribuitoUsd <= 30);
  ok('  e ciò che non trova posto è DICHIARATO', r1.distribuitoUsd + r1.nonCollocatoUsd === 30);

  // Il tetto per ORDINE morde prima di quello per mercato quando è più stretto.
  const r2 = ridistribuisci({ righe: [{ marketId: '0xa', capitalUsd: 10, netPerDay: 9 }],
    capitaleLiberato: 100, tettoMercatoUsd: 130, tettoOrdineUsd: 20 });
  ok('il tetto per ORDINE limita la riga a due gambe', r2.righe[0].capitalUsd === 40);
  ok('  e il resto resta non collocato', r2.nonCollocatoUsd === 70);

  ok('tetto per mercato non leggibile ⇒ non si ridistribuisce al buio',
    ridistribuisci({ righe, capitaleLiberato: 30, tettoMercatoUsd: null }).distribuitoUsd === 0);
  ok('nessuna riga ⇒ tutto non collocato, e lo dice',
    ridistribuisci({ righe: [], capitaleLiberato: 30, tettoMercatoUsd: 65 }).nonCollocatoUsd === 30);
  ok('niente da ridistribuire ⇒ nessun tocco',
    ridistribuisci({ righe, capitaleLiberato: 0, tettoMercatoUsd: 65 }).tocchi === 0);
  ok('una riga senza rendimento leggibile va in fondo, non si indovina una priorità',
    ridistribuisci({ righe: [{ marketId: '0xz', capitalUsd: 0, netPerDay: null }, { marketId: '0xa', capitalUsd: 0, netPerDay: 5 }],
      capitaleLiberato: 65, tettoMercatoUsd: 65, tettoOrdineUsd: 100 }).righe[1].capitalUsd === 65);

  console.log(`\nquotabilita: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { verdettoQuotabilita, ridistribuisci, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

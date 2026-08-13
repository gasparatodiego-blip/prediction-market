#!/usr/bin/env node
'use strict';
// LA MANOPOLA DELLA DISTANZA A 0,444 (2,0¢ SULLA BANDA MODALE) — test dell'operatore, 13 agosto 2026.
//
// ═══ COSA CAMBIA, DETTO CON PRECISIONE ═══════════════════════════════════════════════════════════════
// Il valore PRECEDENTE non era `0,222`: la manopola era **spenta** (`FRAZIONE_DEFAULT === null`) e la
// posizione la decideva `planBehindBest` da sola. `0,222` è la MEDIANA MISURATA degli ordini di oggi
// (1,0¢ su banda 4,5¢), cioè una descrizione del comportamento, non una configurazione. Per tornare
// indietro si CANCELLA la riga dall'ecosystem — non si scrive `0.222`, che sarebbe un pavimento nuovo
// dove prima non ce n'era nessuno. Questo file lo fissa, così la manovra inversa non si indovina.
//
// ═══ COSA SI DIFENDE — proprietà, non il caso singolo ════════════════════════════════════════════════
//   §1 · l'aritmetica: 0,444 × v, con v = max_spread (la banda corretta del 13 agosto, non la metà).
//   §2 · IL PALETTO, che è il vincolo non negoziabile: mai oltre il bordo premiante, per QUALUNQUE
//        frazione e su una spazzata di bande/tick/mid — non solo a 0,444.
//   §3 · MAI PRIMO SUL LIBRO: il prezzo può solo ALLONTANARSI dal mid. Vale per costruzione, e si
//        prova su una spazzata invece che su un esempio.
//   §4 · gli altri presidi restano quelli di prima: banda illeggibile ⇒ nessun obiettivo; il rifiuto
//        «mai-primo» continua a rifiutare; il pavimento premiante non passa da qui.
//   §5 · OGNI ORDINE PORTA LA DISTANZA EFFETTIVA nel giornale — `distanzaMidC` e `distanzaObiettivo`
//        sul referto di piazzamento, che è ciò con cui l'osservatore misurerà l'effetto vero.
//   §6 · il valore dichiarato nell'ecosystem è 0,444 sui TRE processi che decidono un prezzo.
//
// Nessuno stato viene toccato: tutte le funzioni qui sotto sono pure e ricevono l'ambiente per argomento.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const D = require('./distanza-obiettivo');
const { raggioBandaCents } = require('../banda-premiante');
const { planBehindBest, bandBounds } = require('./top-of-book');
const { prezzoInCoda } = require('./prezzo-in-coda');

const VALORE = '0.444';
const ENV = { [D.ENV_FRAZIONE]: VALORE };

console.log('\n══ 1 · L\'ARITMETICA — 0,444 × v, con v = max_spread');
{
  ok('la manopola SPENTA è il valore precedente, e vale null',
    D.FRAZIONE_DEFAULT === null && D.leggiFrazione({}) === null);
  ok('  quindi «tornare indietro» = cancellare la riga, non scrivere 0.222',
    D.leggiFrazione({ [D.ENV_FRAZIONE]: '' }) === null);
  ok('0,444 si legge come 0,444', D.leggiFrazione(ENV) === 0.444);
  // v È max_spread, non la metà: è la correzione del 13 agosto (§5-bis p.155), e se tornasse
  // dimezzata questo test direbbe 1,0¢ invece di 2,0¢ — cioè il test la sorveglia.
  ok('la banda modale ha v = 4,5¢', raggioBandaCents(4.5) === 4.5);
  const d = D.distanzaObiettivoCents({ maxSpreadCents: 4.5, env: ENV });
  ok('  ⇒ obiettivo 2,0¢ dal mid', Math.abs(d.distanzaC - 1.998) < 0.01, `${d.distanzaC}¢`);
  ok('  e il motivo lo dichiara per esteso', /0\.444/.test(d.motivo) && /4\.5/.test(d.motivo), d.motivo);
  // La proprietà, non il numero: su una banda più stretta l'obiettivo scala con lei. È la ragione per
  // cui la manopola è una FRAZIONE e non dei centesimi assoluti.
  const stretta = D.distanzaObiettivoCents({ maxSpreadCents: 3, env: ENV });
  ok('su banda 3¢ l\'obiettivo scala a 1,33¢ (frazione, non centesimi)',
    Math.abs(stretta.distanzaC - 1.332) < 0.01, `${stretta.distanzaC}¢`);
  ok('  e resta sempre una frazione di v, mai un valore fisso',
    Math.abs(d.distanzaC / 4.5 - stretta.distanzaC / 3) < 1e-6);
}

console.log('\n══ 2 · IL PALETTO — mai oltre il bordo premiante, per QUALUNQUE frazione');
{
  // La spazzata: mid da 5¢ a 95¢, bande da 1¢ a 10¢, i due tick del venue, e frazioni che vanno dal
  // valore nuovo fino all'assurdo. Il paletto non deve dipendere da nessuno di questi.
  let casi = 0, fuori = 0, sopraObiettivo = 0;
  let peggiore = null;
  for (const midC of [5, 12, 25, 37, 50, 63, 78, 91, 95]) {
    for (const vC of [1, 2, 3, 4.5, 5.5, 8, 10]) {
      for (const tick of [0.01, 0.001]) {
        for (const fr of [0.444, 0.7, D.FRAZIONE_MASSIMA, 2, 50]) {
          const scoringMid = midC / 100;
          const b = bandBounds({ scoringMid, bandRadiusCents: vC, tick });
          if (!b.readable) continue;
          const obi = D.distanzaObiettivoCents({ maxSpreadCents: vC, frazione: fr });
          if (obi.distanzaC == null) continue;
          // Il prezzo di partenza: un tick dentro il bordo alto, cioè il caso in cui la manopola ha
          // più spazio per spingere.
          const partenza = Math.min(b.hi, scoringMid - tick);
          const r = D.applicaObiettivo({ prezzo: partenza, scoringMid, bandLo: b.lo, distanzaC: obi.distanzaC, tick });
          casi += 1;
          if (r.prezzo < b.lo - 1e-9) { fuori += 1; if (!peggiore) peggiore = { midC, vC, tick, fr, p: r.prezzo, lo: b.lo }; }
          if (r.prezzo > partenza + 1e-9) sopraObiettivo += 1;
        }
      }
    }
  }
  ok(`spazzata di ${casi} combinazioni (mid × banda × tick × frazione)`, casi > 400, String(casi));
  ok('MAI un prezzo oltre il bordo premiante', fuori === 0, peggiore ? JSON.stringify(peggiore) : 'nessuno');
  ok('  e mai un prezzo più VICINO al mid di quello di partenza', sopraObiettivo === 0, String(sopraObiettivo));

  // Il caso limite dichiarato nel modulo: una frazione assurda produce il BORDO, non un ordine fuori.
  const v = 4.5, scoringMid = 0.50, tick = 0.01;
  const b = bandBounds({ scoringMid, bandRadiusCents: v, tick });
  const obiAssurdo = D.distanzaObiettivoCents({ maxSpreadCents: v, frazione: 10 });
  const rAssurdo = D.applicaObiettivo({ prezzo: scoringMid - tick, scoringMid, bandLo: b.lo, distanzaC: obiAssurdo.distanzaC, tick });
  ok('una frazione di 10× si CLAMPA a FRAZIONE_MASSIMA', obiAssurdo.frazione === D.FRAZIONE_MASSIMA);
  ok('  e l\'ordine si ferma AL BORDO, dichiarandolo', rAssurdo.alBordo === true && rAssurdo.prezzo >= b.lo - 1e-9);
  ok('  con il motivo che dice «mai fuori»', /mai fuori/.test(rAssurdo.motivo), rAssurdo.motivo);

  // ⚠ E A 0,444 IL PALETTO NON MORDE sulla banda modale: 2,0¢ su un raggio di 4,5¢ resta comodamente
  // dentro. È la verifica che l'operatore ha chiesto — «regge anche a 0,444» — e la risposta è che a
  // 0,444 non serve nemmeno, perché la richiesta è meno della metà del raggio.
  const r444 = D.applicaObiettivo({ prezzo: scoringMid - tick, scoringMid, bandLo: b.lo,
    distanzaC: D.distanzaObiettivoCents({ maxSpreadCents: v, env: ENV }).distanzaC, tick });
  ok('a 0,444 sulla banda modale il bordo NON viene toccato', r444.alBordo === false);
  ok('  e la distanza effettiva è 2,0¢', Math.abs(r444.distanzaEffettivaC - 2) < 0.051, `${r444.distanzaEffettivaC}¢`);
}

console.log('\n══ 3 · MAI PRIMO SUL LIBRO — la manopola può solo allontanare');
{
  const tick = 0.01, scoringMid = 0.50, v = 4.5;
  // Un concorrente a 50¢: un tick dietro sarebbe 49¢ (1,0¢ dal mid). La manopola deve spingere a 48¢.
  const senza = planBehindBest({ bestOther: 0.50, tick, scoringMid, bandRadiusCents: v, fallbackOffsetCents: 1, env: {} });
  const con = planBehindBest({ bestOther: 0.50, tick, scoringMid, bandRadiusCents: v, fallbackOffsetCents: 1, env: ENV });
  ok('senza manopola il prezzo è un tick dietro il migliore', senza.ok && Math.abs(senza.price - 0.49) < 1e-9, String(senza.price));
  ok('  a 1,0¢ dal mid', Math.abs(senza.offsetCents - 1) < 0.01, `${senza.offsetCents}¢`);
  ok('con la manopola il prezzo si allontana', con.ok && con.price < senza.price - 1e-9, `${senza.price} → ${con.price}`);
  ok('  a 2,0¢ dal mid', Math.abs(con.offsetCents - 2) < 0.051, `${con.offsetCents}¢`);
  ok('  e NON è in cima al libro', con.onTop === false);
  ok('  e resta dentro banda', con.price >= con.bandLo - 1e-9 && con.price <= con.bandHi + 1e-9);
  // Se le regole di sempre hanno GIÀ messo il prezzo più lontano, la manopola non lo riavvicina: sarebbe
  // risalire nella coda, cioè esattamente ciò che «mai primo» vieta.
  // ⚠ Il concorrente sta a 47¢: un tick dietro dà 46¢, cioè 4,0¢ dal mid — già oltre l'obiettivo di
  // 2,0¢ e ancora dentro la banda (4,5¢). A 46¢ il caso è quello giusto; a 45¢ il lato non si
  // quoterebbe affatto, e il test misurerebbe il rifiuto invece del non-riavvicinamento.
  const gia = planBehindBest({ bestOther: 0.47, tick, scoringMid, bandRadiusCents: v, fallbackOffsetCents: 1, env: ENV });
  ok('un prezzo già oltre l\'obiettivo NON viene riavvicinato', gia.ok && Math.abs(gia.price - 0.46) < 1e-9, String(gia.price));
  ok('  e resta a 4,0¢ dal mid, non torna a 2,0¢', gia.ok && Math.abs(gia.offsetCents - 4) < 0.051, `${gia.offsetCents}¢`);
}

console.log('\n══ 4 · GLI ALTRI PRESIDI, INTATTI');
{
  const tick = 0.01, scoringMid = 0.50;
  // Banda illeggibile ⇒ nessun obiettivo: applicarne uno senza sapere dov'è il bordo vorrebbe dire
  // poter uscire dalla banda, che è la cosa che il paletto vieta.
  const cieca = D.distanzaObiettivoCents({ maxSpreadCents: null, env: ENV });
  ok('banda non leggibile ⇒ nessun obiettivo', cieca.distanzaC === null);
  ok('  e lo dichiara invece di indovinare', /non leggibile/.test(cieca.motivo));
  // Il rifiuto «mai-primo» resta un rifiuto: la manopola si applica DOPO, e non può resuscitare un
  // lato che la regola ha deciso di non quotare.
  const rifiuto = planBehindBest({ bestOther: 0.40, tick, scoringMid, bandRadiusCents: 4.5, fallbackOffsetCents: 1, env: ENV });
  ok('un tick dietro fuori banda ⇒ NON si quota, anche con la manopola accesa',
    rifiuto.ok === false && rifiuto.quotabile === false, rifiuto.mode || '');
  // La manopola non tocca il pavimento premiante né i tetti: non li nomina, e questa è la proprietà.
  const src = fs.readFileSync(path.join(__dirname, 'distanza-obiettivo.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  ok('non tocca il pavimento premiante', !/pavimentoPremiante|pavimentoDepth/.test(src));
  ok('  né i tetti di capitale', !/capPerMarketUsd|MARKET_CAP/.test(src));
  ok('  né la coerenza delle soglie', !/coerenza|adattaAlleSoglie/.test(src));
}

console.log('\n══ 5 · LA DISTANZA EFFETTIVA VIAGGIA SU OGNI ORDINE');
{
  const rules = {
    readable: true, tick: 0.01, maxSpreadCents: 4.5,
    books: { yes: { scoringMid: 0.50 }, no: { scoringMid: 0.50 } },
  };
  const depth = { yes: { bids: [{ price: 0.50, size: 500 }], asks: [{ price: 0.54, size: 500 }] }, no: { bids: [], asks: [] } };
  const prima = process.env[D.ENV_FRAZIONE];
  process.env[D.ENV_FRAZIONE] = VALORE;
  const q = prezzoInCoda({ book: 'yes', side: 'BUY', rules, depth, ownOrders: [], offsetCents: 1 });
  if (prima === undefined) delete process.env[D.ENV_FRAZIONE]; else process.env[D.ENV_FRAZIONE] = prima;

  ok('il prezzo si calcola', q.ok === true, q.reason || '');
  ok('LA DISTANZA EFFETTIVA DAL MID è un numero, su ogni ordine', typeof q.offsetCents === 'number', `${q.offsetCents}¢`);
  ok('  ed è 2,0¢, cioè quella che la manopola ha prodotto', Math.abs(q.offsetCents - 2) < 0.051, `${q.offsetCents}¢`);
  ok('LA MANOPOLA CHE L\'HA PRODOTTA viaggia accanto', !!q.distanzaObiettivo, JSON.stringify(q.distanzaObiettivo || null));
  ok('  con la frazione richiesta', !!(q.distanzaObiettivo && q.distanzaObiettivo.frazione === 0.444));
  ok('  e con il verdetto sul bordo', !!(q.distanzaObiettivo && q.distanzaObiettivo.alBordo === false));
  // ⚠ E CON LA MANOPOLA SPENTA la distanza si misura lo stesso: il giornale non dipende dal test in
  // corso, altrimenti il confronto prima/dopo non esisterebbe.
  const q0 = prezzoInCoda({ book: 'yes', side: 'BUY', rules, depth, ownOrders: [], offsetCents: 1 });
  ok('spenta, la distanza è comunque nel referto', typeof q0.offsetCents === 'number', `${q0.offsetCents}¢`);
  ok('  e la manopola si dichiara assente, non zero', q0.distanzaObiettivo === null);
}

console.log('\n══ 6 · IL VALORE È LO STESSO SUI TRE PROCESSI CHE DECIDONO UN PREZZO');
{
  const cfg = require(path.join(ROOT, 'agents', 'ecosystem.config.js'));
  const chi = ['agent41-realloc-scheduler', 'agent40-manual-reprice', 'dashboard'];
  const valori = chi.map((n) => {
    const a = (cfg.apps || []).find((x) => x.name === n);
    return { n, v: a && a.env ? a.env[D.ENV_FRAZIONE] : undefined };
  });
  for (const { n, v } of valori) ok(`${n} dichiara la manopola`, v === VALORE, String(v));
  ok('  e i tre valori COINCIDONO (una divergenza qui è la classe D1)',
    new Set(valori.map((x) => x.v)).size === 1);
  ok('  e il valore dichiarato, letto dalla funzione vera, vale 0,444',
    D.leggiFrazione({ [D.ENV_FRAZIONE]: valori[0].v }) === 0.444);
}

console.log(`\n${pass} verdi, ${fail} rossi`);
process.exit(fail === 0 ? 0 : 1);

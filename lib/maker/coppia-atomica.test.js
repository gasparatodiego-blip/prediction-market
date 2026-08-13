#!/usr/bin/env node
'use strict';
// lib/maker/coppia-atomica.test.js — LA COPPIA SI VALUTA PRIMA, NON SI RIPARA DOPO.
//
// ═══ IL GUASTO, MISURATO ═════════════════════════════════════════════════════════════════════════
// Le due gambe di un mercato si inviano in SEQUENZA e il tetto per ordine si valuta per SINGOLO
// ordine. Su un mercato a mid estremo le due gambe costano cifre molto diverse — `Q` share uguali per
// lato, quindi la cara costa `Q x p` e l'economica `Q x (1-p)` — e quando la cara sfonda il tetto ciò
// che succede dipende SOLO dall'ordine di invio:
//
//   · economica prima ⇒ viene piazzata, poi la cara viene rifiutata, e il ripristino la cancella;
//   · cara prima     ⇒ viene rifiutata subito e la coppia si abbandona intera.
//
// Il 12 agosto 2026, con capitale reale: Massachusetts (mid 0,04) ha fatto il primo caso SEI VOLTE in
// un'ora — `leg-rolled-back` x6 — e Vindman (mid 0,913) il secondo. Stesso difetto, due facce, e la
// faccia che tocca dipende dal caso.
//
// ⚠ NON ERA UN BUCO DI ESPOSIZIONE, e questo file lo asserisce: `leg-orphan` è ZERO su tutta la
// giornata, cioè il ripristino ha sempre funzionato. Era SPRECO — due chiamate al venue e una
// posizione in coda bruciate a ogni giro per un ordine cancellato mezzo secondo dopo — più una
// finestra breve in cui una gamba sola era davvero sul libro e poteva essere riempita.
//
// ═══ COSA SI PRECONTROLLA, E COSA NO — LA DISTINZIONE È DELIBERATA ═══════════════════════════════
// Si precontrolla ciò che si può SAPERE prima: il tetto per ordine è puro e deterministico, dipende
// dal controvalore e dai limiti, entrambi già noti al momento di costruire la coppia. Si valuta con
// `evaluateManualCapGate`, LA STESSA funzione che poi rifiuterebbe davvero e con LO STESSO `caps`.
//
// Non si precontrolla ciò che si scopre solo DOPO: banda, mai-primo-sul-libro e minimo premiante
// dipendono dal LIBRO nell'istante del piazzamento. Leggerlo qui vorrebbe dire due letture a mezzo
// secondo di distanza che possono divergere — un precontrollo che dice «passa» su un libro che non è
// più quello. Per quelli la garanzia resta il RIPRISTINO, che agisce sul fatto invece che sulla
// previsione, ed è già in servizio e già provato dai sei rollback veri di oggi.
//
// Nessuna rete, nessun venue, nessun capitale: tutto iniettato.

const { runBulkAllocation } = require('./bulk-allocate');
const CONC = require('../rewards/concentration');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + 'ca'.repeat(32);

/** Le due gambe come le emette `plan-to-orders`: share UGUALI per lato, prezzi complementari. */
const coppiaAlMid = (marketId, mid, capitale) => {
  const q = +(capitale / 0.98).toFixed(2);          // Q = capitale / costoCoppia
  const pYes = +mid.toFixed(3);
  const pNo = +(1 - mid).toFixed(3);
  return [
    { marketId, title: 'M', book: 'yes', side: 'BUY', price: pYes, size: q, coppia: marketId, gamba: 'yes' },
    { marketId, title: 'M', book: 'no', side: 'BUY', price: pNo, size: q, coppia: marketId, gamba: 'no' },
  ];
};

function mondo(opts = {}) {
  const fatti = { piazzati: [], cancellati: [], audit: [] };
  const deps = {
    now: () => 1_700_000_000_000,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    engine: {},
    resolveCaps: () => ({ readable: true,
      maxOpenNotionalUsd: 10_000,
      maxOrderNotionalUsd: opts.orderCap,
      liveMinCapUsd: opts.orderCap,
      effectiveOrderCapUsd: opts.orderCap,
      maxOrdersPerWindow: 1000 }),
    audit: (r) => fatti.audit.push(r),
    placeOrder: async (spec) => { fatti.piazzati.push(spec); return { ok: true, sent: true, orderId: `ord-${fatti.piazzati.length}` }; },
    cancelOrder: async ({ orderId, marketId }) => { fatti.cancellati.push({ orderId, marketId }); return { ok: true, cancelled: true }; },
  };
  return { deps, fatti };
}

(async () => {

  // Il tetto per ordine VERO di oggi, letto dal modulo e non ricopiato: se la taratura si muove, questo
  // file si muove con lei invece di diventare rosso senza segnalare un difetto.
  const TETTO = CONC.liveMinOrderCapUsd(661.61);

  console.log('\n══ 1 · COPPIA CON UNA GAMBA OLTRE IL TETTO ⇒ ZERO ORDINI INVIATI');
  {
    // Massachusetts, la GEOMETRIA vera del 12 agosto: mid 0,04, quindi la gamba NO porta quasi tutto
    // il capitale e la YES quasi niente. Il capitale della fixture e' DERIVATO dal tetto in vigore
    // (gamba cara = 1,25 x tetto), non scritto a mano: coi numeri originali — $26 contro un tetto di
    // $21,34 — la coppia ha smesso di sfondare quando il tetto e' salito a $35,63, e il test sarebbe
    // diventato rosso pur difendendo una regola intatta.
    const m = mondo({ orderCap: TETTO });
    const capitaleCheSfonda = +(TETTO * 1.25 * 0.98 / 0.96).toFixed(2);
    const righe = coppiaAlMid(MKT, 0.04, capitaleCheSfonda);
    const r = await runBulkAllocation({ rows: righe }, m.deps);

    ok('NESSUN ordine è stato inviato', m.fatti.piazzati.length === 0, `inviati ${m.fatti.piazzati.length}`);
    ok('  e quindi nemmeno una cancellazione di ripristino', m.fatti.cancellati.length === 0);
    ok('  entrambe le gambe risultano rifiutate', r.refused === 2 && r.placed === 0, `refused ${r.refused} placed ${r.placed}`);
    ok('  con il gate esplicito', r.results.every((x) => x.gate === 'coppia-non-atomica'));
    ok('  e il motivo dice QUALE gamba e PERCHE',
      r.results.every((x) => /non passa il tetto per ordine/.test(x.reason))
      && /oltre il tetto per ordine/.test(r.results[0].reason),
      r.results[0].reason.slice(0, 90));
    ok('  ed è scritto a verbale una volta sola, non due',
      m.fatti.audit.filter((a) => a.outcome === 'coppia-scartata-preflight').length === 1);
    ok('  la riga di audit nomina la gamba fuori e il suo controvalore',
      m.fatti.audit.some((a) => a.outcome === 'coppia-scartata-preflight' && a.gambaFuori === 'no' && a.notionalUsd > TETTO));
  }

  console.log('\n══ 2 · LO STESSO MERCATO CON LE GAMBE INVERTITE: STESSO ESITO');
  {
    // È il punto del lavoro. Prima, invertire l'ordine cambiava l'esito — orfana o abbandono. Ora no.
    const a = mondo({ orderCap: TETTO });
    const dritte = coppiaAlMid(MKT, 0.04, +(TETTO * 1.25 * 0.98 / 0.96).toFixed(2));
    await runBulkAllocation({ rows: dritte }, a.deps);

    const b = mondo({ orderCap: TETTO });
    const rovesce = [dritte[1], dritte[0]];   // la gamba CARA per prima
    const rb = await runBulkAllocation({ rows: rovesce }, b.deps);

    ok('con la gamba cara per prima: zero inviati', b.fatti.piazzati.length === 0);
    ok('con la gamba cara per seconda: zero inviati', a.fatti.piazzati.length === 0);
    ok('  l ESITO NON DIPENDE PIU DALL ORDINE DI INVIO',
      a.fatti.piazzati.length === b.fatti.piazzati.length
      && a.fatti.cancellati.length === b.fatti.cancellati.length);
    ok('  e in nessuno dei due casi nasce un orfana', rb.results.every((x) => x.status !== 'orphan'));
  }

  console.log('\n══ 3 · COPPIA VALIDA ⇒ ENTRAMBE INVIATE (il precontrollo non blocca il lavoro normale)');
  {
    // Mid 0,50, capitale al tetto per mercato: è la riga ordinaria del piano di oggi.
    const m = mondo({ orderCap: TETTO });
    const r = await runBulkAllocation({ rows: coppiaAlMid(MKT, 0.5, CONC.capPerMarketUsd(661.61)) }, m.deps);
    ok('due ordini inviati', m.fatti.piazzati.length === 2, `inviati ${m.fatti.piazzati.length}`);
    ok('  uno per libro', m.fatti.piazzati[0].book === 'yes' && m.fatti.piazzati[1].book === 'no');
    ok('  placed = 2, refused = 0', r.placed === 2 && r.refused === 0);
    ok('  nessuna cancellazione', m.fatti.cancellati.length === 0);
    ok('  e nessuna riga di scarto a verbale',
      !m.fatti.audit.some((a) => a.outcome === 'coppia-scartata-preflight'));
  }

  console.log('\n══ 4 · UN ORDINE SINGOLO NON È UNA COPPIA: PASSA (e le CHIUSURE restano esenti)');
  {
    // LA GARANZIA CHE IL PROMPT CHIEDE ESPLICITAMENTE. Una gamba di uscita su una posizione che esiste
    // deve poter partire DA SOLA, altrimenti l'atomicità ci murerebbe dentro una posizione — che è un
    // guasto peggiore di quello che previene.
    //
    // La proprietà è STRUTTURALE, non promessa: il precontrollo è dentro `if (accoppiato)`, e
    // `accoppiato` è vero solo quando il gruppo ha più di una riga. Le righe di chiusura non portano
    // `coppia`, quindi ognuna è un gruppo di UNA e il precontrollo non la vede nemmeno.
    const m = mondo({ orderCap: TETTO });
    const uscita = [{ marketId: MKT, title: 'M', book: 'yes', side: 'SELL', price: 0.9, size: 100 }];
    const r = await runBulkAllocation({ rows: uscita }, m.deps);
    // $90 di controvalore: MOLTO oltre il tetto per ordine. Se il precontrollo lo toccasse, sarebbe
    // rifiutato qui invece che dal gate vero, che ha l'esenzione di chiusura.
    ok('un ordine singolo oltre il tetto NON è fermato dal precontrollo della coppia',
      m.fatti.piazzati.length === 1, `inviati ${m.fatti.piazzati.length}`);
    ok('  e arriva alla corsia di piazzamento, dove vive l esenzione di chiusura',
      m.fatti.piazzati[0].side === 'SELL' && m.fatti.piazzati[0].price === 0.9);
    ok('  nessuno scarto per coppia non atomica', !r.results.some((x) => x.gate === 'coppia-non-atomica'));
  }

  console.log('\n══ 5 · IL PRECONTROLLO FALLISCE CHIUSO, MAI APERTO');
  {
    const m = mondo({ orderCap: undefined });   // limite assente
    const r = await runBulkAllocation({ rows: coppiaAlMid(MKT, 0.5, 26) }, m.deps);
    ok('tetto per ordine assente ⇒ nessun ordine inviato', m.fatti.piazzati.length === 0);
    ok('  limite assente non vale illimitato', r.placed === 0 && r.refused === 2);
  }

  console.log('\n══ 6 · IL RIPRISTINO NON È STATO TOCCATO: RESTA LA RETE PER I CANCELLI DEL LIBRO');
  {
    // Banda e mai-primo non si possono precontrollare: si scoprono al piazzamento. Qui la prima gamba
    // passa il tetto e viene RIFIUTATA DAL VENUE — la seconda non parte e la prima viene ritirata.
    const m = mondo({ orderCap: TETTO });
    let n = 0;
    m.deps.placeOrder = async (spec) => {
      m.fatti.piazzati.push(spec); n += 1;
      if (n === 2) return { ok: false, gate: 'mai-primo-sul-libro', reason: 'un tick dietro uscirebbe dalla banda' };
      return { ok: true, sent: true, orderId: `ord-${n}` };
    };
    const r = await runBulkAllocation({ rows: coppiaAlMid(MKT, 0.5, 26) }, m.deps);
    ok('la prima gamba parte (il precontrollo non poteva saperlo)', m.fatti.piazzati.length === 2);
    ok('  la seconda viene rifiutata dal venue', r.refused === 1);
    ok('  e la prima viene RITIRATA', m.fatti.cancellati.length === 1);
    ok('  nessuna gamba resta orfana', !r.results.some((x) => x.status === 'orphan'));
    ok('  la riga ritirata lo dichiara', r.results.some((x) => x.status === 'rolled-back'));
  }

  console.log('\n══ 7 · LA STRUTTURA: il precontrollo vive dentro il ramo della coppia');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'bulk-allocate.js'), 'utf8');
    const vive = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
    ok('il precontrollo è condizionato ad `accoppiato`',
      /if\s*\(accoppiato\)\s*\{[\s\S]{0,400}?evaluateManualCapGate/.test(vive));
    ok('  e usa LA STESSA funzione del gate vero, non una seconda aritmetica',
      /evaluateManualCapGate\(\{\s*notionalUsd/.test(vive)
      && /evaluateManualCapGate\s*[,}]/.test(vive.split('\n').find((r) => /require\('\.\/manual-order'\)/.test(r)) || ''));
    ok('  il file non ridichiara nessun tetto per ordine proprio',
      !/const\s+\w*ORDER_CAP\w*\s*=\s*\d/.test(vive) && !/effectiveOrderCapUsd\s*=\s*\d/.test(vive));
  }

  console.log(`\nCOPPIA ATOMICA: ${pass} passati, ${fail} falliti\n`);
  if (fail) process.exit(1);
})().catch((e) => { console.error('\nESPLOSO:', e.message); process.exit(1); });

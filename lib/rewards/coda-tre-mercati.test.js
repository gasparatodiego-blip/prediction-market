#!/usr/bin/env node
'use strict';
// UNA CODA DI TRE MERCATI, UNO ALLA VOLTA, E NESSUN PIAZZAMENTO SENZA UN TOCCO.
//
// ═══ IL TERZO PERCORSO ═══════════════════════════════════════════════════════════════════════════════
// La tab «Ottimizza» aveva due modi di arrivare al venue, e nessuno dei due faceva questa cosa:
//
//   · «1 · Anteprima» sulla card  →  abilita il mercato. Non piazza.
//   · «Conferma ed esegui»        →  RESET: cancella tutto, spegne ciò che esce dal piano, riaccende e
//                                    ripiazza il piano INTERO. È il percorso del riallocatore delle 6h,
//                                    e resta invariato: serve a far coincidere il venue con un piano.
//   · la coda                     →  i mercati scelti a mano, uno per volta, ognuno con la sua conferma.
//
// ═══ LA PROPRIETÀ CHE QUESTO FILE DEVE PROVARE ═══════════════════════════════════════════════════════
// Che la coda non possa piazzare. Non «che non lo faccia»: che non possa. Il modulo che la governa non
// importa nessun endpoint e non ha nessuna funzione di invio — decide soltanto SE scorrere, sentendo un
// esito prodotto da qualcun altro. Il test qui sotto conta le chiamate a un finto endpoint e pretende
// che ce ne sia una per ogni conferma esplicita, e zero altrove.

const fs = require('fs');
const path = require('path');
const C = require('./coda-piazzamento');
const { planAllocation } = require('./allocator');
const { gambeDiUnaRiga } = require('./plan-to-orders');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

console.log('\n══ 1 · LE REGOLE DELLA CODA');
C.selfcheck();
pass += 17;

// ── UN PIANO VERO CON TRE MERCATI ───────────────────────────────────────────────────────────────────
// Tre mid diversi, così i prezzi delle gambe sono davvero diversi fra loro e un valore preso dal
// mercato sbagliato si vedrebbe.
const campione = (mid) => (tsMs) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId: 'M', tokenIdYes: 'T', adjMid: mid, plainMid: mid,
  bestBid: +(mid - 0.01).toFixed(4), bestAsk: +(mid + 0.01).toFixed(4),
  bidDepthInBand: 1000, askDepthInBand: 1000,
  bandLow: mid - 0.05, bandHigh: mid + 0.05, tick: 0.01, src: 'ws',
});
const MID = { A: 0.40, B: 0.55, D: 0.72 };
const byMarket = new Map();
const marketTokens = new Map();
const potByCond = new Map();
const minSizeByMarket = new Map();
const maxSpreadByMarket = new Map();
for (const [id, mid] of Object.entries(MID)) {
  const f = campione(mid);
  byMarket.set(id, [{ ...f(0), marketId: id, tokenIdYes: 'T' + id }, { ...f(86_400_000), marketId: id, tokenIdYes: 'T' + id }]);
  marketTokens.set(id, 'T' + id);
  potByCond.set(id, 100);
  minSizeByMarket.set(id, 20);
  maxSpreadByMarket.set(id, 4.5);
}
const plan = planAllocation({
  byMarket, marketTokens, tapeByToken: new Map(), potByCond, minSizeByMarket, maxSpreadByMarket,
  budgetUsd: 300, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', usePairCost: true,
});
const righe = new Map(plan.rows.map((r) => [r.marketId, r]));

console.log('\n══ 2 · IL PIANO PRODUCE LE TRE RIGHE');
{
  ok('tre mercati nel piano', plan.rows.length === 3, `${plan.rows.length}`);
  ok('  con mid diversi', new Set(plan.rows.map((r) => r.mid)).size === 3);
  ok('  e ognuno con le sue due gambe', plan.rows.every((r) => {
    const g = gambeDiUnaRiga(r, r.computedDefaultOffsetTicks);
    return !g.scarto && g.rows && g.rows.length === 2;
  }));
}

// ── IL BANCO: la coda VERA, più un finto endpoint che conta le chiamate ─────────────────────────────
function banco(ids) {
  let coda = ids.slice();
  let esiti = [];
  let ultimoAt = null;
  const chiamate = [];                    // ogni invio "reale" finisce qui
  let orologio = 1000;

  // L'unico modo di piazzare, in questo banco come nel pannello: un tocco esplicito dell'operatore.
  // La coda non lo chiama mai da sé — non ha modo di farlo.
  const confermaEPiazza = () => {
    const testa = coda[0];
    if (!testa) return null;
    const r = righe.get(testa);
    const g = gambeDiUnaRiga(r, r.computedDefaultOffsetTicks);
    const inviati = [];
    // Le due gambe, ognuna con la sua conferma: è ciò che fa OrderPanel col bottone della gamba 2.
    for (const [i, leg] of g.rows.entries()) {
      chiamate.push({ marketId: testa, book: leg.book, price: leg.price, size: leg.size });
      inviati.push(leg);
      const esito = { marketId: testa, legIdx: i, legTotal: g.rows.length, at: (orologio += 1) };
      const d = C.decidiAvanzamento({ coda, esito, ultimoAt });
      if (d.avanza) {
        ultimoAt = esito.at;
        const next = C.avanza({ coda, esiti, come: 'piazzato', nome: r.name ?? r.marketId, capitale: r.capital });
        coda = next.coda; esiti = next.esiti;
      }
    }
    return inviati;
  };
  const salta = () => {
    const testa = coda[0];
    if (!testa) return;
    const r = righe.get(testa);
    const next = C.avanza({ coda, esiti, come: 'saltato', nome: r ? (r.name ?? r.marketId) : null });
    coda = next.coda; esiti = next.esiti;
  };
  return {
    testa: () => coda[0] ?? null,
    resto: () => coda.slice(),
    confermaEPiazza, salta, chiamate,
    riepilogo: () => C.riepilogo(esiti),
  };
}

console.log('\n══ 3 · TRE IN CODA: CONFERMA → SALTA → CONFERMA (punto 12)');
{
  const b = banco(['A', 'B', 'D']);
  ok('la testa è il primo messo in coda', b.testa() === 'A');
  ok('  e gli altri due sono in attesa', b.resto().join() === 'A,B,D');

  // ── 1 · CONFERMA IL PRIMO
  const g1 = b.confermaEPiazza();
  ok('confermato A: due gambe inviate', g1.length === 2);
  ok('  e la coda è avanzata a B', b.testa() === 'B');

  // I VALORI DEL SECONDO SONO QUELLI DEL PIANO DI B — non ricalcolati, non quelli di A.
  const rB = righe.get('B');
  const gB = gambeDiUnaRiga(rB, rB.computedDefaultOffsetTicks);
  ok('il mercato mostrato ora è B, col SUO mid', rB.mid === MID.B, String(rB.mid));
  ok('  e le sue gambe non sono quelle di A',
    gB.rows[0].price !== gambeDiUnaRiga(righe.get('A'), righe.get('A').computedDefaultOffsetTicks).rows[0].price,
    `B ${gB.rows[0].price} vs A ${gambeDiUnaRiga(righe.get('A'), righe.get('A').computedDefaultOffsetTicks).rows[0].price}`);
  ok('  il prezzo YES di B sta sotto il mid di B', gB.rows[0].price < MID.B);

  // ── 2 · SALTA IL SECONDO
  b.salta();
  ok('saltato B: la coda è avanzata a D', b.testa() === 'D');
  ok('  e NESSUN invio è avvenuto per B',
    b.chiamate.filter((c) => c.marketId === 'B').length === 0,
    `${b.chiamate.filter((c) => c.marketId === 'B').length} invii`);

  // ── 3 · CONFERMA IL TERZO
  b.confermaEPiazza();
  ok('confermato D: la coda è vuota', b.testa() === null);

  // ── IL RIEPILOGO FINALE
  const r = b.riepilogo();
  ok('RIEPILOGO: 2 piazzati, 1 saltato', r.piazzati === 2 && r.saltati === 1, JSON.stringify(r));
  ok('  3 trattati in tutto', r.trattati === 3);
  ok('  capitale solo dei due piazzati',
    Math.abs(r.capitaleUsd - (righe.get('A').capital + righe.get('D').capital)) < 0.01,
    `${r.capitaleUsd} vs ${righe.get('A').capital + righe.get('D').capital}`);
  ok('  il saltato non ha impegnato capitale',
    r.capitaleUsd !== righe.get('A').capital + righe.get('B').capital + righe.get('D').capital);
}

console.log('\n══ 4 · NESSUN INVIO SENZA UNA CONFERMA ESPLICITA (punto 13)');
{
  const b = banco(['A', 'B', 'D']);
  ok('appena creata la coda: ZERO invii', b.chiamate.length === 0);

  // Un esito che arriva da FUORI (un ordine piazzato a mano altrove) non deve piazzare niente qui.
  const d = C.decidiAvanzamento({ coda: ['A', 'B', 'D'], esito: { marketId: 'Z', legIdx: 0, legTotal: 1, at: 5 } });
  ok('un esito su un altro mercato non fa scorrere la coda', d.avanza === false && d.motivo === 'altro-mercato');
  ok('  e non produce invii', b.chiamate.length === 0);

  b.salta(); b.salta();
  ok('due «salta»: la coda scorre e continua a non inviare niente',
    b.testa() === 'D' && b.chiamate.length === 0);

  b.confermaEPiazza();
  ok('UNA conferma → esattamente 2 invii (le due gambe di quel mercato)', b.chiamate.length === 2);
  ok('  entrambi sullo stesso mercato', b.chiamate.every((c) => c.marketId === 'D'));
  ok('  su libri diversi', b.chiamate[0].book !== b.chiamate[1].book);
  ok('  e nessun invio sui mercati saltati',
    b.chiamate.filter((c) => c.marketId === 'A' || c.marketId === 'B').length === 0);
}

console.log('\n══ 5 · LA PRIMA GAMBA NON FA AVANZARE (l altra resterebbe orfana)');
{
  const solaPrima = C.decidiAvanzamento({ coda: ['A'], esito: { marketId: 'A', legIdx: 0, legTotal: 2, at: 1 } });
  ok('gamba 1 di 2 → la coda NON avanza', solaPrima.avanza === false && solaPrima.motivo === 'gamba-mancante');
  const seconda = C.decidiAvanzamento({ coda: ['A'], esito: { marketId: 'A', legIdx: 1, legTotal: 2, at: 2 } });
  ok('  gamba 2 di 2 → avanza', seconda.avanza === true);
}

console.log('\n══ 6 · IL CABLAGGIO DI OGGI, E CIÒ CHE NON È STATO TOCCATO');
{
  // ═══ AGGIORNATO IL 6 AGOSTO 2026 ═══════════════════════════════════════════════════════════════
  // Le sezioni 1-5 provano il MODULO della coda e restano valide: `coda-piazzamento.js` è puro, non
  // conosce endpoint e non può piazzare. Ma il PANNELLO non lo usa più: la coda a N mercati con una
  // conferma per gamba è stata sostituita da una conferma per proposta, con entrambe le gambe.
  //
  // La proprietà che questa sezione custodisce non è «la coda è cablata»: è «non esiste un percorso
  // che arrivi al venue senza un tocco esplicito». Quella vale identica, e qui si verifica sul
  // percorso che oggi porta davvero a un ordine.
  const ap = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  const cf = leggi('app', 'components', 'ConfermaEPiazza.tsx');

  ok('il pannello NON usa più il modulo della coda',
    !/from '@\/lib\/rewards\/coda-piazzamento'/.test(ap),
    'senza il bottone che ci metteva dentro i mercati, la coda era irraggiungibile');
  ok('  e non è rimasto stato della coda scritto e mai letto',
    !/setCodaBusy|setCodaErr|CODA_KEY/.test(ap));

  ok('il piazzamento passa dal componente di conferma condiviso', /<ConfermaEPiazza/.test(ap));
  ok('  che manda alla rotta del singolo mercato', /'\/api\/maker\/manual\/place-market'/.test(cf));
  // La parola «bulk-allocate» compare nel componente solo dentro un commento che spiega PERCHE' non la
  // si usa (quella rotta e' un reset: cancellerebbe ogni altro ordine a riposo). Quindi si cerca la
  // CHIAMATA, non la menzione: un test sulla menzione punirebbe la spiegazione.
  const chiamate = (cf.match(/fetch\(\s*'([^']+)'/g) || []);
  ok('  e NON chiama la rotta del reset',
    !chiamate.some((c) => c.includes('bulk-allocate')), chiamate.join(' '));

  // IL TOCCO ESPLICITO, CONTATO. Due bottoni: uno apre il riepilogo (anteprima, non scrive), l'altro
  // invia. Non esiste una terza strada da cui parta `preview:false`.
  const inviiVeri = (cf.match(/chiedi\(false\)/g) || []).length;
  ok('esiste UN SOLO punto da cui parte un invio vero', inviiVeri === 1, `${inviiVeri}`);
  ok('  ed è il bottone dentro il dialog', /data-conferma-invia[\s\S]{0,600}?chiedi\(false\)/.test(cf));
  ok('  mentre il bottone della card chiede l anteprima', /data-conferma-apri[\s\S]{0,900}?chiedi\(true\)/.test(cf));
  ok('  e annullare non invia niente', /data-conferma-annulla[\s\S]{0,300}?setAperto\(false\)/.test(cf));

  // Il modulo resta puro e resta in repo: la decisione «quando può avanzare una coda» non è sbagliata,
  // semplicemente non ha più un chiamante nella UI.
  const mod = leggi('lib', 'rewards', 'coda-piazzamento.js');
  ok('IL MODULO DELLA CODA NON PUÒ PIAZZARE: nessuna fetch, nessun endpoint',
    !/fetch\(/.test(mod) && !/\/api\//.test(mod));

  // E il percorso in blocco resta dov era.
  ok('«Conferma ed esegui» (reset) è ancora al suo posto', /data-alloc-bulk-run/.test(ap));
  ok('  e passa ancora da bulk-allocate', /'\/api\/maker\/manual\/bulk-allocate'/.test(ap));

  // L'AVVISO CHE LEGA I DUE PERCORSI. Il reset cancella anche ciò che si è appena piazzato a un tocco:
  // è ciò che un reset deve fare, ma dalla schermata non si leggeva.
  ok('c è un avviso quando il reset disferebbe il lavoro appena fatto',
    /data-alloc-bulk-vs-queue/.test(ap));
  ok('  condizionato ai piazzamenti VERI, non sempre a schermo',
    /piazzati\.length > 0 && \(/.test(ap),
    'un avviso che c è sempre è un avviso che non si legge più');
  ok('  e dice le due cose che contano: che cancella, e che il piano viene ricalcolato',
    /cancella/.test(ap) && /ricalcolato in questo momento/.test(ap));
}

console.log(`\nun tocco per mercato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

'use strict';
// scripts/ricerca/distanza-referto-21-agosto.js — REFERTO SULLA DISTANZA DAL MID. SOLA LETTURA.
//
//   node scripts/ricerca/distanza-referto-21-agosto.js
//
// Nessun ordine, nessuna cancellazione, nessun riavvio, nessuna scrittura fuori da data/ricerca/.
//
// FONTI, tutte lette e nessuna ricostruita:
//   · gli ordini a riposo VERI  → data/ricerca/ordini-vivi-21ago.json (letto dal venue con
//     l'adapter CANCEL-ONLY, che non ha `postOrder` nella sua superficie)
//   · il book vivo              → /tmp/rewards-bot-<utente>/clob-live-books.json (agent34)
//   · banda/minSize/montepremi  → /tmp/rewards-bot-<utente>/liquidity-rewards.json (agent24)
//   · il prezzo che il motore produrrebbe → `prezzoInCoda`, LA FUNZIONE DI PRODUZIONE
//   · la formula del venue      → lib/rewardScore.js + lib/banda-premiante.js
//
// ⚠ IL BOOK YES E' GIA' IL BOOK FUSO, ED E' UNA MISURA NON UN'ASSUNZIONE: su tutti e quattro i
// mercati `NO.bids[i].size == YES.asks[i].size` esattamente, e `NO.bid.price == 1 - YES.ask.price`.
// Quindi le nostre DUE gambe BUY (una per token) sono, nello spazio YES, un bid E un ask: siamo
// bilaterali, e `qMin` non ci applica la penalita' del lato singolo.

const fs = require('fs');
const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const { fileRuntime } = require(path.join(RADICE, 'lib', 'percorsi-runtime'));
const { prezzoInCoda } = require(path.join(RADICE, 'lib', 'maker', 'prezzo-in-coda'));
const { raggioBandaCents, punteggio: S } = require(path.join(RADICE, 'lib', 'banda-premiante'));
const { parseOrders, adjustedMid, qMin } = require(path.join(RADICE, 'lib', 'rewardScore'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (fin(x) ? +x.toFixed(2) : null);
const r4 = (x) => (fin(x) ? +x.toFixed(4) : null);

const ORDINI = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const LIBRI  = JSON.parse(fs.readFileSync(fileRuntime(require(path.join(RADICE,'lib','percorsi-runtime')).NOMI.bookVivi), 'utf8'));
const BOARD  = JSON.parse(fs.readFileSync(fileRuntime(require(path.join(RADICE,'lib','percorsi-runtime')).NOMI.boardNormalizzato), 'utf8'));
const perId  = new Map(BOARD.markets.map((m) => [m.marketId, m]));

/** Le distanze chieste dall'operatore, in centesimi. */
const DISTANZE = [0.63, 1.0, 1.5, 2.05, 2.50];

// ── PARTE 0 — LA PREMESSA, VERIFICATA ─────────────────────────────────────────────────────────────
const perMercato = new Map();
for (const o of ORDINI.ordini) {
  if (!perMercato.has(o.market)) perMercato.set(o.market, []);
  perMercato.get(o.market).push(o);
}

const mercati = [];
for (const [id, ord] of perMercato) {
  const b = perId.get(id);
  const L = LIBRI.markets[id];
  if (!b || !L) { mercati.push({ id, errore: !b ? 'assente dal board' : 'assente dai book vivi' }); continue; }
  const v       = Number(b.maxSpread);
  const minSize = Number(b.minSize);
  const tick    = Number(b.tickSize);
  const monte   = Number(b.dailyPool);
  const y = L.yes, n = L.no;

  // Il mid di SCORING: ricalcolato sui soli ordini >= minSize, come fa il venue.
  const by = parseOrders(y.levels.bids, true), ay = parseOrders(y.levels.asks, false);
  const bn = parseOrders(n.levels.bids, true), an = parseOrders(n.levels.asks, false);
  const midY = adjustedMid(by, ay, minSize, y.plainMid);
  const midN = adjustedMid(bn, an, minSize, n.plainMid);

  // Le nostre gambe, portate nello spazio YES.
  const nostri = ord.map((o) => {
    const yes = String(o.asset_id) === String(b.tokenId);
    return { ...o, lato: yes ? 'YES' : 'NO',
      prezzoYes: yes ? o.price : +(1 - o.price).toFixed(6),
      spazio: yes ? 'bid' : 'ask',
      distanzaC: +(Math.abs((yes ? o.price : 1 - o.price) - midY) * 100).toFixed(3) };
  });
  const size = nostri.length ? nostri[0].size : null;

  // ── IL LIBRO ALTRUI: il book vivo MENO i nostri ordini ───────────────────────────────────────
  const togli = (livelli, prezzo, quanto) => livelli.map((l) => (Math.abs(Number(l.price) - prezzo) < 1e-9
    ? { price: Number(l.price), size: Math.max(0, Number(l.size) - quanto) } : { price: Number(l.price), size: Number(l.size) }));
  let bidsAltrui = y.levels.bids.map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  let asksAltrui = y.levels.asks.map((l) => ({ price: Number(l.price), size: Number(l.size) }));
  for (const o of nostri) {
    if (o.spazio === 'bid') bidsAltrui = togli(bidsAltrui, o.prezzoYes, o.size);
    else                    asksAltrui = togli(asksAltrui, o.prezzoYes, o.size);
  }
  const Qlato = (livelli) => livelli.reduce((a, l) => (l.size >= minSize ? a + S(Math.abs(l.price - midY) * 100, v) * l.size : a), 0);
  const Qb = Qlato(bidsAltrui), Qa = Qlato(asksAltrui);
  const Qcomp = qMin(Qb, Qa, midY);

  mercati.push({ id, titolo: b.title, v, raggioC: raggioBandaCents(v), minSize, tick, monte,
    midY: r4(midY), midN: r4(midN), size, nostri,
    QbidsAltrui: r2(Qb), QasksAltrui: r2(Qa), Qcomp: r2(Qcomp),
    midFuoriRange: midY < 0.10 || midY > 0.90,
    libro: { y, n, bidsAltrui, asksAltrui, board: b } });
}

// ── PARTE 2 — LA TABELLA ─────────────────────────────────────────────────────────────────────────
/** Il prezzo che il motore PRODURREBBE davvero, chiedendo la frazione `fr`. Funzione di produzione. */
function prezzoVero(m, book, fr) {
  const b = m.libro.board;
  const rules = { readable: true, tick: m.tick, maxSpreadCents: m.v,
    books: { yes: { scoringMid: m.midY }, no: { scoringMid: m.midN } } };
  const depth = { yes: { bids: m.libro.y.levels.bids, asks: m.libro.y.levels.asks },
    no: { bids: m.libro.n.levels.bids, asks: m.libro.n.levels.asks } };
  const nostriDiQuestoLibro = m.nostri
    .filter((o) => (book === 'yes' ? o.lato === 'YES' : o.lato === 'NO'))
    .map((o) => ({ price: o.price, size: o.size, side: 'BUY' }));
  const prima = process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;
  if (fr == null) delete process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;
  else process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = String(fr);
  const p = prezzoInCoda({ book, side: 'BUY', rules, depth, ownOrders: nostriDiQuestoLibro, ownSize: m.size });
  if (prima === undefined) delete process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;
  else process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = prima;
  if (!p.ok) return { ok: false, motivo: p.reason, modo: p.mode };
  const distC = book === 'yes' ? Math.abs(p.price - m.midY) * 100 : Math.abs((1 - p.price) - m.midY) * 100;
  return { ok: true, prezzo: p.price, distanzaC: +distC.toFixed(3), modo: p.mode, onTop: p.onTop, bestOther: p.bestOther };
}

/** Quota e reward per una distanza EFFETTIVA (una sola, uguale sui due lati) su un mercato. */
function resa(m, dBid, dAsk) {
  if (!fin(m.size) || m.size < m.minSize) return { sottoMinimo: true, Qu: 0, quota: 0, rewardGiorno: 0 };
  const Qbid = S(dBid, m.v) * m.size;
  const Qask = S(dAsk, m.v) * m.size;
  const Qu = qMin(Qbid, Qask, m.midY);
  const quota = Qu + m.Qcomp > 0 ? Qu / (Qu + m.Qcomp) : 0;
  return { Sbid: r4(S(dBid, m.v)), Sask: r4(S(dAsk, m.v)), Qu: r2(Qu), quota: +quota.toFixed(7),
    rewardGiorno: +(quota * m.monte).toFixed(4) };
}

const tabella = [];
for (const d of DISTANZE) {
  const righe = [];
  for (const m of mercati) {
    if (m.errore) continue;
    const fr = d / m.raggioC;
    const py = prezzoVero(m, 'yes', fr);
    const pn = prezzoVero(m, 'no', fr);
    const ideale = resa(m, d, d);
    const reale = py.ok && pn.ok ? resa(m, py.distanzaC, pn.distanzaC) : null;
    righe.push({ id: m.id.slice(0, 14), titolo: m.titolo, monte: m.monte, Qcomp: m.Qcomp,
      frazioneChiesta: +fr.toFixed(4),
      ideale, reale,
      prezzoYes: py.ok ? py.prezzo : null, distYesC: py.ok ? py.distanzaC : null, motivoYes: py.ok ? py.modo : py.motivo,
      prezzoNo: pn.ok ? pn.prezzo : null, distNoC: pn.ok ? pn.distanzaC : null, motivoNo: pn.ok ? pn.modo : pn.motivo });
  }
  tabella.push({ distanzaChiestaC: d,
    totaleIdeale: +righe.reduce((a, r) => a + (r.ideale ? r.ideale.rewardGiorno : 0), 0).toFixed(4),
    totaleReale:  +righe.reduce((a, r) => a + (r.reale ? r.reale.rewardGiorno : 0), 0).toFixed(4),
    righe });
}

// Il punto di partenza: le distanze EFFETTIVE di adesso, lette dagli ordini veri.
const oggi = mercati.filter((m) => !m.errore).map((m) => {
  const bid = m.nostri.find((o) => o.spazio === 'bid'), ask = m.nostri.find((o) => o.spazio === 'ask');
  const rr = bid && ask ? resa(m, bid.distanzaC, ask.distanzaC) : null;
  return { id: m.id.slice(0, 14), titolo: m.titolo, monte: m.monte, Qcomp: m.Qcomp, size: m.size,
    distBidC: bid ? bid.distanzaC : null, distAskC: ask ? ask.distanzaC : null, ...rr };
});
const oggiTot = +oggi.reduce((a, r) => a + (r.rewardGiorno || 0), 0).toFixed(4);

const out = {
  generatoIl: new Date().toISOString(),
  ordiniLettiIl: ORDINI.atIso,
  bookGeneratoIl: LIBRI.generatedAt,
  boardGeneratoIl: BOARD.meta && BOARD.meta.generatedAt,
  premessa: {
    mercatiAttesi: 5, mercatiTrovati: mercati.length,
    gambeAttese: 10, gambeTrovate: ORDINI.n,
    nozionaleAtteso: 268.38,
    nozionaleTrovato: +ORDINI.ordini.reduce((a, o) => a + o.price * o.size, 0).toFixed(2),
  },
  mercati: mercati.map((m) => ({ id: m.id, titolo: m.titolo, v: m.v, minSize: m.minSize, tick: m.tick,
    monte: m.monte, midY: m.midY, size: m.size, midFuoriRange: m.midFuoriRange,
    QbidsAltrui: m.QbidsAltrui, QasksAltrui: m.QasksAltrui, Qcomp: m.Qcomp,
    nostri: m.nostri.map((o) => ({ lato: o.lato, prezzo: o.price, prezzoYes: o.prezzoYes, spazio: o.spazio, size: o.size, distanzaC: o.distanzaC })) })),
  oggi: { righe: oggi, totaleGiorno: oggiTot },
  tabella,
};
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'distanza-referto-21-agosto.json'), JSON.stringify(out, null, 1));

// ── STAMPA ────────────────────────────────────────────────────────────────────────────────────────
console.log('═══ PARTE 0 — LA PREMESSA ═══');
console.log(`ordini letti dal venue: ${ORDINI.atIso}  ·  book: ${LIBRI.generatedAt}  ·  board: ${out.boardGeneratoIl}`);
console.log(`mercati: attesi 5, trovati ${mercati.length}   gambe: attese 10, trovate ${ORDINI.n}   nozionale: atteso $268,38, trovato $${out.premessa.nozionaleTrovato}`);
for (const m of mercati) {
  if (m.errore) { console.log(` ! ${m.id.slice(0, 14)} ${m.errore}`); continue; }
  console.log(` ${m.id.slice(0, 14)} v=${m.v}¢ tick=${m.tick} minSize=${m.minSize} pool=$${m.monte}/g midYES=${m.midY}${m.midFuoriRange ? ' ⚠FUORI [0,10·0,90]' : ''}`);
  for (const o of m.nostri) console.log(`     ${o.lato} BUY @${o.price} ×${o.size}  → spazio YES ${o.spazio} ${o.prezzoYes}  = ${o.distanzaC}¢ dal mid`);
  console.log(`     Qaltrui: bids ${m.QbidsAltrui}  asks ${m.QasksAltrui}  ⇒ Qcomp(qMin) ${m.Qcomp}`);
}
console.log('\n═══ OGGI, dalle distanze VERE ═══');
for (const r of oggi) console.log(` ${r.id} ${r.distBidC}/${r.distAskC}¢  S=${r.Sbid}  Qu=${r.Qu}  quota=${(r.quota * 100).toFixed(4)}%  → $${r.rewardGiorno}/g  (pool $${r.monte})`);
console.log(` TOTALE MODELLATO OGGI: $${oggiTot}/giorno`);

console.log('\n═══ PARTE 2 — LA TABELLA ═══');
for (const t of tabella) {
  console.log(`\n── distanza chiesta ${t.distanzaChiestaC}¢ ──`);
  for (const r of t.righe) {
    const re = r.reale ? `reale ${r.distYesC}/${r.distNoC}¢ S=${r.reale.Sbid} quota=${(r.reale.quota * 100).toFixed(4)}% $${r.reale.rewardGiorno}/g` : `reale: ${r.motivoYes} / ${r.motivoNo}`;
    console.log(`  ${r.id} ideale S=${r.ideale.Sbid} quota=${(r.ideale.quota * 100).toFixed(4)}% $${r.ideale.rewardGiorno}/g  ||  ${re}`);
  }
  console.log(`  TOTALE ideale $${t.totaleIdeale}/g  ·  reale $${t.totaleReale}/g  ·  ×${(t.totaleReale / oggiTot).toFixed(2)} vs oggi`);
}
console.log('\nscritto data/ricerca/distanza-referto-21-agosto.json');

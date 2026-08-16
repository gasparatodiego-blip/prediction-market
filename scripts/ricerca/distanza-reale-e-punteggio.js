'use strict';
// scripts/ricerca/distanza-reale-e-punteggio.js — DOVE CADE L'ORDINE, E QUANTO VALE.
//
//   node scripts/ricerca/distanza-reale-e-punteggio.js [--capitale 1500]
//
// SOLA LETTURA. Nessun ordine, nessun invio, nessuna scrittura fuori da data/ricerca/.
//
// ═══ FASE A — LE 112 RIGHE CON `distanzaMidC` NEL GIORNALE ═══════════════════════════════════════
// Prima di usarle bisogna sapere da dove vengono. Non si assume: si contano `source`, `op`,
// `outcome`, `marketRef` e `placement`, e si guarda se i `marketRef` sono identificatori di mercati
// veri o fixture generate da un test.
//
// ═══ FASE B — LA MISURA DAL VIVO ════════════════════════════════════════════════════════════════
// Board di agent24 → `valutaAmmissibilita` (la funzione VERA di lib/maker/selezione-mercati.js, non
// una copia dei quattro vincoli) → per ogni ammissibile si legge il book CLOB dei due token e si
// chiama `prezzoInCoda`, cioè LA STESSA funzione che decide il prezzo in produzione. La distanza dal
// mid non viene ricalcolata qui: è `offsetCents`, quello che il motore stesso dichiara.
//
// ⚠ DUE SCENARI, PERCHE' LA MANOPOLA E' ACCESA. `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = '0.95'` sta
// in agents/ecosystem.config.js su agent40 (riga 206) e agent41 (riga 323): il prezzo che il bot
// piazzerebbe ADESSO non e' «un tick dietro», e misurare solo la manopola spenta descriverebbe un
// bot che non esiste. Si misurano entrambi.
//
// ═══ FASE C — IL PUNTEGGIO E I REWARD ═══════════════════════════════════════════════════════════
// Formula del venue da lib/rewardScore.js (`scoreBook`, `qMin`) e raggio di banda da
// lib/banda-premiante.js. Il montepremi e' `rewardsDailyRate` DI QUEL MERCATO, mai una media.
//
// ⚠ L'APPROSSIMAZIONE, DICHIARATA: la quota si calcola come `Qu / (Qu + Qcomp)` dove `Qcomp` e' il
// `Qmin` dell'INTERO libro altrui. Il venue calcola invece il `Qmin` di OGNI maker e poi normalizza,
// e la somma dei Qmin individuali e' <= il Qmin dell'aggregato. Quindi questo modello SOVRASTIMA il
// concorrente e SOTTOSTIMA la nostra quota: e' l'errore nella direzione prudente, ed e' la stessa
// approssimazione che usa `quadraticUserShare` in lib/rewardScore.js.

const { apiGet, inParallelo, scrivi } = require('./screening-lib');
const { valutaAmmissibilita, punteggio: punteggioSelezione } = require('../../lib/maker/selezione-mercati');
const { prezzoInCoda } = require('../../lib/maker/prezzo-in-coda');
const { raggioBandaCents, punteggio: S } = require('../../lib/banda-premiante');
const { scoreBook, adjustedMid, parseOrders, qMin } = require('../../lib/rewardScore');
const { sharePerLato } = require('../../lib/rewards/size-da-capitale');
const { capPerMarketUsd, pavimentoPremiante, LIVE_MIN_ORDER_CAP_USD } = require('../../lib/rewards/concentration');

const fs = require('fs');
const path = require('path');

const argomenti = process.argv.slice(2);
const arg = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? Number(argomenti[i + 1]) : difetto;
};
const CAPITALE = arg('--capitale', 1500);
const RADICE = path.resolve(__dirname, '..', '..');
const GIORNALE = path.join(RADICE, 'data', 'polymarket-maker-audit.jsonl');
const BOARD = path.join(RADICE, 'data', 'liquidity-rewards.json');
/** Il valore in servizio nell'ecosystem, letto dal file e non scritto a mano qui sotto. */
const FRAZIONE_ECOSYSTEM = (() => {
  try {
    const t = fs.readFileSync(path.join(RADICE, 'agents', 'ecosystem.config.js'), 'utf8');
    const m = t.match(/MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V:\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
})();

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const q = (arr, p) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FASE A
// ════════════════════════════════════════════════════════════════════════════════════════════════
function faseA() {
  let righe = [];
  try {
    righe = fs.readFileSync(GIORNALE, 'utf8').split('\n')
      .filter((l) => l.includes('distanzaMidC'))
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    return { errore: `giornale non leggibile: ${e.message}`, n: 0 };
  }
  const conta = (f) => {
    const m = new Map();
    for (const r of righe) { const k = String(f(r)); m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const ts = righe.map((r) => r.ts).filter(fin);
  const dist = righe.map((r) => r.inCoda && r.inCoda.distanzaMidC).filter(fin);

  // ── IL DISCRIMINANTE: un conditionId vero e' 32 byte pseudocasuali. Una fixture di test e' un
  //    byte ripetuto 32 volte. Non si giudica «sembra finto»: si verifica il periodo.
  const sintetico = (ref) => {
    const s = String(ref || '').replace(/^cid_/, '').replace(/^0x/, '');
    if (s.length < 8) return false;
    for (let p = 1; p <= 4; p += 1) {
      if (s.length % p) continue;
      const unita = s.slice(0, p);
      if (s === unita.repeat(s.length / p)) return true;
    }
    return false;
  };
  const perRef = conta((r) => r.marketRef);
  const refFinti = perRef.filter(([ref]) => sintetico(ref));

  return {
    n: righe.length,
    periodo: ts.length ? { da: new Date(Math.min(...ts)).toISOString(), a: new Date(Math.max(...ts)).toISOString(), minuti: +((Math.max(...ts) - Math.min(...ts)) / 60000).toFixed(1) } : null,
    source: conta((r) => r.source),
    op: conta((r) => r.op),
    outcome: conta((r) => r.outcome),
    userId: conta((r) => r.userId),
    placement: conta((r) => r.placement),
    marketRef: perRef,
    marketRefSintetici: refFinti,
    righeSuRefSintetici: refFinti.reduce((a, [, n]) => a + n, 0),
    distanzeDistinte: [...new Set(dist)].sort((a, b) => a - b),
    conDepth: righe.filter((r) => r.inCoda && r.inCoda.depth !== null).length,
    conDistanzaObiettivo: righe.filter((r) => r.inCoda && r.inCoda.distanzaObiettivo !== null).length,
    accettate: righe.filter((r) => !String(r.outcome || '').startsWith('reject')).length,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FASE B + C
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Il book grezzo del CLOB per un token. `null` se non letto — mai un libro vuoto inventato. */
async function libro(tokenId) {
  if (!tokenId) return null;
  const r = await apiGet(`/book?token_id=${tokenId}`, 0, 'clob.polymarket.com');
  if (!r.ok || !r.dati || typeof r.dati !== 'object') return null;
  const bids = Array.isArray(r.dati.bids) ? r.dati.bids : null;
  const asks = Array.isArray(r.dati.asks) ? r.dati.asks : null;
  if (!bids || !asks) return null;
  return { bids, asks };
}

/** La distanza dal mid dei due lati, con `prezzoInCoda` — la funzione di produzione. */
function distanze(riga, libroYes, libroNo, midYes, midNo) {
  const rules = {
    readable: true,
    tick: Number(riga.tickSize),
    maxSpreadCents: Number(riga.rewardsMaxSpread),
    books: { yes: { scoringMid: midYes }, no: { scoringMid: midNo } },
  };
  const depth = {
    yes: { bids: libroYes.bids, asks: libroYes.asks },
    no: { bids: libroNo.bids, asks: libroNo.asks },
  };
  const uno = (book) => {
    const p = prezzoInCoda({ book, side: 'BUY', rules, depth, ownOrders: [] });
    return p.ok
      ? { ok: true, prezzo: p.price, distanzaC: p.offsetCents, modo: p.mode, onTop: p.onTop, bestOther: p.bestOther, alone: p.alone,
        manopola: p.distanzaObiettivo ? { spostato: p.distanzaObiettivo.spostato, alBordo: p.distanzaObiettivo.alBordo, richiestaC: p.distanzaObiettivo.distanzaRichiestaC } : null }
      : { ok: false, motivo: p.reason, quotabile: p.quotabile, modo: p.mode };
  };
  return { yes: uno('yes'), no: uno('no') };
}

/**
 * Il punteggio e i reward attesi per UN mercato, date le due distanze.
 * `Qcomp` e' il Qmin del libro altrui, gia' calcolato con la formula del venue.
 */
function resa({ riga, capitale, distYesC, distNoC, midYes, Qcomp, costoCoppia }) {
  const v = raggioBandaCents(Number(riga.rewardsMaxSpread));
  const minSize = Number(riga.rewardsMinSize);
  if (v == null || !fin(minSize)) return null;
  const share = sharePerLato({ capitaleUsd: capitale, pairCostUsd: costoCoppia });
  const Q = share && fin(share.shares) ? share.shares : null;
  if (!fin(Q) || Q <= 0) return null;
  // Sotto il minimo del venue il punteggio e' ZERO, non «piu' basso» (§4.2).
  const sopraMinimo = Q >= minSize;
  const Sy = S(distYesC, Number(riga.rewardsMaxSpread));
  const Sn = S(distNoC, Number(riga.rewardsMaxSpread));
  const QuBid = sopraMinimo ? Sy * Q : 0;
  const QuAsk = sopraMinimo ? Sn * Q : 0;
  const Qu = qMin(QuBid, QuAsk, midYes);
  const denom = Qu + (fin(Qcomp) ? Qcomp : 0);
  const quota = denom > 0 ? Qu / denom : 0;
  const monte = Number(riga.rewardsDailyRate);
  return {
    shareLato: +Q.toFixed(2), sopraMinimo, minSize,
    Syes: +Sy.toFixed(6), Sno: +Sn.toFixed(6),
    Qu: +Qu.toFixed(3), Qcomp: fin(Qcomp) ? +Qcomp.toFixed(3) : null,
    quota: +quota.toFixed(6),
    montepremiGiorno: fin(monte) ? monte : null,
    rewardGiorno: fin(monte) ? +(quota * monte).toFixed(4) : null,
  };
}

async function main() {
  console.log('═══ FASE A — le righe con distanzaMidC nel giornale ═══');
  const A = faseA();
  console.log(JSON.stringify(A, null, 1));
  const utilizzabili = A.n > 0 && A.righeSuRefSintetici === 0 && A.accettate > 0;
  console.log(`\n⇒ UTILIZZABILI: ${utilizzabili ? 'SI' : 'NO'}`);

  console.log('\n═══ FASE B — il board di adesso ═══');
  const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
  const mercati = Array.isArray(board.markets) ? board.markets : [];
  const ora = Date.now();
  console.log(`board generato ${board.meta && board.meta.generatedAt} · ${mercati.length} righe · eta ${((ora - Date.parse(board.meta.generatedAt)) / 60000).toFixed(1)} min`);

  const giudizi = mercati.map((r) => ({ riga: r, v: valutaAmmissibilita(r, { ora }) }));
  const ammissibili = giudizi.filter((g) => g.v.ammissibile);
  const perMotivo = new Map();
  for (const g of giudizi) if (!g.v.ammissibile) perMotivo.set(g.v.motivo, (perMotivo.get(g.v.motivo) || 0) + 1);
  console.log(`ammissibili: ${ammissibili.length}/${mercati.length}`);
  console.log('esclusi per:', [...perMotivo.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '));

  // ── I due scenari della manopola ────────────────────────────────────────────────────────────────
  const scenari = [
    { nome: 'ecosystem', frazione: FRAZIONE_ECOSYSTEM },
    { nome: 'manopola-spenta', frazione: null },
  ];
  console.log(`manopola letta da ecosystem.config.js: ${FRAZIONE_ECOSYSTEM === null ? 'ASSENTE' : FRAZIONE_ECOSYSTEM}`);

  const righe = [];
  await inParallelo(ammissibili, 4, async (g) => {
    const r = g.riga;
    const [ly, ln] = await Promise.all([libro(r.tokenId), libro(r.tokenIdNo)]);
    if (!ly || !ln) { righe.push({ conditionId: r.conditionId, titolo: r.question, errore: 'book non letto' }); return; }

    const v = Number(r.rewardsMaxSpread);
    const minSize = Number(r.rewardsMinSize);
    // Il mid di scoring e' quello del venue: ricalcolato sui soli ordini >= rewardsMinSize.
    const by = parseOrders(ly.bids, true); const ay = parseOrders(ly.asks, false);
    const bn = parseOrders(ln.bids, true); const an = parseOrders(ln.asks, false);
    const midYes = adjustedMid(by, ay, minSize, Number(r.mid));
    const midNo = adjustedMid(bn, an, minSize, fin(Number(r.mid)) ? 1 - Number(r.mid) : null);
    if (!fin(midYes) || !fin(midNo)) { righe.push({ conditionId: r.conditionId, titolo: r.question, errore: 'mid non calcolabile' }); return; }

    const punteggioLibro = scoreBook(ly, v, minSize, Number(r.mid));

    const perScenario = {};
    for (const s of scenari) {
      if (s.frazione === null) delete process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;
      else process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V = s.frazione;
      perScenario[s.nome] = distanze(r, ly, ln, midYes, midNo);
    }
    delete process.env.MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V;

    righe.push({
      conditionId: r.conditionId,
      titolo: r.question,
      categoria: r.category,
      minSize,
      maxSpreadC: v,
      raggioBandaC: raggioBandaCents(v),
      tick: Number(r.tickSize),
      montepremiGiorno: Number(r.rewardsDailyRate),
      oreAllaScadenza: g.v.oreAllaScadenza == null ? null : +g.v.oreAllaScadenza.toFixed(1),
      bestBidYes: by[0] ? by[0].price : null,
      bestAskYes: ay[0] ? ay[0].price : null,
      bestBidNo: bn[0] ? bn[0].price : null,
      midYes: +midYes.toFixed(4),
      midNo: +midNo.toFixed(4),
      costoCoppia: +(midYes + midNo).toFixed(4),
      spreadYesC: by[0] && ay[0] ? +((ay[0].price - by[0].price) * 100).toFixed(2) : null,
      Qcomp: +punteggioLibro.Qmin.toFixed(3),
      QcompBids: +punteggioLibro.Qbids.toFixed(3),
      QcompAsks: +punteggioLibro.Qasks.toFixed(3),
      scenari: perScenario,
    });
  }, (fatti, tot) => { if (fatti % 5 === 0 || fatti === tot) console.log(`  … ${fatti}/${tot}`); });

  const buone = righe.filter((r) => !r.errore);
  console.log(`\nmercati misurati: ${buone.length}/${ammissibili.length}`);

  // ── LA DISTRIBUZIONE DELLE DISTANZE ─────────────────────────────────────────────────────────────
  const distribuzioni = {};
  for (const s of scenari) {
    const d = [];
    let nonQuotabili = 0;
    for (const r of buone) {
      const sc = r.scenari[s.nome];
      for (const lato of ['yes', 'no']) {
        if (sc[lato].ok) d.push(sc[lato].distanzaC); else nonQuotabili += 1;
      }
    }
    distribuzioni[s.nome] = {
      frazione: s.frazione,
      nGambe: d.length, gambeNonQuotabili: nonQuotabili,
      q25: q(d, 0.25), mediana: q(d, 0.50), q75: q(d, 0.75),
      min: d.length ? Math.min(...d) : null, max: d.length ? Math.max(...d) : null,
    };
  }
  console.log('\n═══ DISTANZA DAL MID (centesimi), per gamba ═══');
  for (const [k, v] of Object.entries(distribuzioni)) {
    console.log(`  ${k.padEnd(16)} n=${v.nGambe} (${v.gambeNonQuotabili} non quotabili) · q25 ${v.q25} · mediana ${v.mediana} · q75 ${v.q75} · [${v.min} … ${v.max}]`);
  }
  const spread = buone.map((r) => r.spreadYesC).filter(fin);
  console.log(`  spread del book (¢): q25 ${q(spread, 0.25)} · mediana ${q(spread, 0.50)} · q75 ${q(spread, 0.75)}`);
  const bande = buone.map((r) => r.raggioBandaC).filter(fin);
  console.log(`  raggio di banda (¢): q25 ${q(bande, 0.25)} · mediana ${q(bande, 0.50)} · q75 ${q(bande, 0.75)}`);

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // FASE C — il punteggio e i reward
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n═══ FASE C — punteggio e reward con $' + CAPITALE + ' ═══');
  const tetto = capPerMarketUsd(CAPITALE);
  const nMax = fin(tetto) && tetto > 0 ? Math.floor(CAPITALE / tetto) : 0;
  console.log(`tetto per mercato $${tetto} · tetto per ordine $${LIVE_MIN_ORDER_CAP_USD} ⇒ mercati finanziabili in parallelo: ${nMax}`);

  // L'ordine con cui il bot sceglie fra due ammissibili: `punteggio` di selezione-mercati.
  const ordinati = [...buone].sort((a, b) => {
    const rigaA = mercati.find((m) => m.conditionId === a.conditionId);
    const rigaB = mercati.find((m) => m.conditionId === b.conditionId);
    const pa = (punteggioSelezione(rigaA) || {}).valore || 0;
    const pb = (punteggioSelezione(rigaB) || {}).valore || 0;
    if (pb !== pa) return pb - pa;
    return String(a.conditionId).localeCompare(String(b.conditionId));
  });

  const scelti = ordinati.slice(0, Math.min(nMax, ordinati.length));
  const stime = [];
  for (const r of scelti) {
    const rigaBoard = mercati.find((m) => m.conditionId === r.conditionId);
    const sc = r.scenari.ecosystem;
    const scOff = r.scenari['manopola-spenta'];
    const tickC = +(r.tick * 100).toFixed(3);
    const voce = {
      conditionId: r.conditionId, titolo: r.titolo, minSize: r.minSize, raggioBandaC: r.raggioBandaC,
      montepremiGiorno: r.montepremiGiorno, capitale: tetto, Qcomp: r.Qcomp,
      distEcosystemC: sc.yes.ok && sc.no.ok ? { yes: sc.yes.distanzaC, no: sc.no.distanzaC } : null,
      distSpentaC: scOff.yes.ok && scOff.no.ok ? { yes: scOff.yes.distanzaC, no: scOff.no.distanzaC } : null,
      tickC,
    };
    const comune = { riga: rigaBoard, capitale: tetto, midYes: r.midYes, Qcomp: r.Qcomp, costoCoppia: r.costoCoppia };
    voce.ecosystem = sc.yes.ok && sc.no.ok ? resa({ ...comune, distYesC: sc.yes.distanzaC, distNoC: sc.no.distanzaC }) : null;
    voce.spenta = scOff.yes.ok && scOff.no.ok ? resa({ ...comune, distYesC: scOff.yes.distanzaC, distNoC: scOff.no.distanzaC }) : null;
    voce.unTick = resa({ ...comune, distYesC: tickC, distNoC: tickC });

    // ── IL TETTO PER ORDINE, sulla gamba cara (l'aritmetica di §5-bis p.126) ────────────────────
    const Q = voce.unTick ? voce.unTick.shareLato : null;
    const caro = Math.max(r.midYes, r.midNo);
    const gambaCara = fin(Q) ? Q * caro : null;
    voce.gambaCaraUsd = fin(gambaCara) ? +gambaCara.toFixed(2) : null;
    voce.entroTettoOrdine = fin(gambaCara) ? gambaCara <= LIVE_MIN_ORDER_CAP_USD : null;

    // Il capitale che il bot potrebbe DAVVERO impegnare qui: il piu' stretto fra il tetto per
    // mercato e quello che la gamba cara consente. Sotto il pavimento premiante non si quota.
    const dalTettoOrdine = caro > 0 ? (LIVE_MIN_ORDER_CAP_USD * r.costoCoppia) / caro : null;
    const cEff = fin(dalTettoOrdine) ? Math.min(tetto, dalTettoOrdine) : tetto;
    const pavimento = pavimentoPremiante(r.minSize);
    voce.capitaleEffettivo = +cEff.toFixed(2);
    voce.pavimentoPremiante = fin(pavimento) ? +pavimento.toFixed(2) : null;
    voce.sopraIlPavimento = fin(pavimento) ? cEff >= pavimento : null;
    const comuneEff = { ...comune, capitale: cEff };
    voce.ecosystemEff = voce.sopraIlPavimento && sc.yes.ok && sc.no.ok ? resa({ ...comuneEff, distYesC: sc.yes.distanzaC, distNoC: sc.no.distanzaC }) : null;
    voce.spentaEff = voce.sopraIlPavimento && scOff.yes.ok && scOff.no.ok ? resa({ ...comuneEff, distYesC: scOff.yes.distanzaC, distNoC: scOff.no.distanzaC }) : null;
    voce.unTickEff = voce.sopraIlPavimento ? resa({ ...comuneEff, distYesC: tickC, distNoC: tickC }) : null;
    stime.push(voce);
  }

  const somma = (k, su = stime) => su.reduce((a, s) => a + (s[k] && fin(s[k].rewardGiorno) ? s[k].rewardGiorno : 0), 0);
  const tot = {
    ecosystem: +somma('ecosystem').toFixed(3), spenta: +somma('spenta').toFixed(3), unTick: +somma('unTick').toFixed(3),
    ecosystemEff: +somma('ecosystemEff').toFixed(3), spentaEff: +somma('spentaEff').toFixed(3), unTickEff: +somma('unTickEff').toFixed(3),
  };
  const sopra = (k) => stime.filter((s) => s[k] && s[k].sopraMinimo).length;
  const capitaleImpegnato = stime.reduce((a, s) => a + (fin(s.capitaleEffettivo) && s.sopraIlPavimento ? s.capitaleEffettivo : 0), 0);
  // Il tetto di §4.13: al piu' due mercati contemporanei, presi dai primi in classifica.
  const primiDue = stime.slice(0, 2);
  const totDue = { ecosystemEff: +somma('ecosystemEff', primiDue).toFixed(3), spentaEff: +somma('spentaEff', primiDue).toFixed(3), unTickEff: +somma('unTickEff', primiDue).toFixed(3) };

  console.log(`\nmercati scelti: ${stime.length} · sopra il minimo del venue: ${sopra('unTick')} · entro il tetto per ordine a $${tetto}: ${stime.filter((s) => s.entroTettoOrdine).length}`);
  console.log(`capitale realmente impegnabile: $${capitaleImpegnato.toFixed(2)} su $${CAPITALE} (il resto NON ha dove andare: solo ${stime.length} mercati ammissibili)`);
  console.log('\n  reward attesi al giorno, somma dei mercati scelti — AL TETTO PIENO $' + tetto + ' (irrealizzabile: sfonda il tetto per ordine):');
  console.log(`    manopola come in ecosystem (${FRAZIONE_ECOSYSTEM})  $${tot.ecosystem.toFixed(3)}/g`);
  console.log(`    manopola spenta (un tick dietro il migliore)   $${tot.spenta.toFixed(3)}/g`);
  console.log(`    a 1 tick dal MID (limite superiore teorico)    $${tot.unTick.toFixed(3)}/g`);
  console.log('\n  reward attesi al giorno — AL CAPITALE REALMENTE PIAZZABILE (tetto per ordine rispettato):');
  console.log(`    manopola come in ecosystem (${FRAZIONE_ECOSYSTEM})  $${tot.ecosystemEff.toFixed(3)}/g`);
  console.log(`    manopola spenta (un tick dietro il migliore)   $${tot.spentaEff.toFixed(3)}/g`);
  console.log(`    a 1 tick dal MID (limite superiore teorico)    $${tot.unTickEff.toFixed(3)}/g`);
  console.log(`\n  e con il tetto di §4.13 (max 2 mercati contemporanei), capitale $${primiDue.reduce((a, s) => a + s.capitaleEffettivo, 0).toFixed(2)}:`);
  console.log(`    ecosystem $${totDue.ecosystemEff.toFixed(3)}/g · spenta $${totDue.spentaEff.toFixed(3)}/g · 1 tick dal mid $${totDue.unTickEff.toFixed(3)}/g`);

  console.log('\n  mercato per mercato (dist ¢ · S · quota · $/g):');
  for (const s of stime) {
    const f = (x) => (x ? `${x.quota * 100 < 0.01 ? (x.quota * 100).toExponential(1) : (x.quota * 100).toFixed(3)}% $${x.rewardGiorno.toFixed(3)}` : '—');
    console.log(`    ${String(s.titolo).slice(0, 46).padEnd(46)} monte $${String(s.montepremiGiorno).padStart(5)}/g · minSize ${String(s.minSize).padStart(3)} · v ${String(s.raggioBandaC).padStart(4)}¢`);
    console.log(`      ecosystem  d=${s.distEcosystemC ? `${s.distEcosystemC.yes}/${s.distEcosystemC.no}` : '—'}¢  S=${s.ecosystem ? `${s.ecosystem.Syes}/${s.ecosystem.Sno}` : '—'}  ${f(s.ecosystem)}`);
    console.log(`      spenta     d=${s.distSpentaC ? `${s.distSpentaC.yes}/${s.distSpentaC.no}` : '—'}¢  S=${s.spenta ? `${s.spenta.Syes}/${s.spenta.Sno}` : '—'}  ${f(s.spenta)}`);
    console.log(`      1 tick mid d=${s.tickC}¢  S=${s.unTick ? `${s.unTick.Syes}/${s.unTick.Sno}` : '—'}  ${f(s.unTick)}  · gamba cara $${s.gambaCaraUsd} ${s.entroTettoOrdine ? '' : '⚠ OLTRE IL TETTO PER ORDINE'}`);
    console.log(`      → a capitale piazzabile $${s.capitaleEffettivo} (pavimento $${s.pavimentoPremiante}${s.sopraIlPavimento ? '' : ' ⚠ SOTTO'}): ecosystem ${f(s.ecosystemEff)} · spenta ${f(s.spentaEff)} · 1 tick ${f(s.unTickEff)}`);
  }

  const f = scrivi('distanza-reale-e-punteggio.json', {
    generatoIl: new Date().toISOString(),
    capitale: CAPITALE,
    tettoPerMercato: tetto,
    tettoPerOrdine: LIVE_MIN_ORDER_CAP_USD,
    frazioneEcosystem: FRAZIONE_ECOSYSTEM,
    faseA: A,
    faseAUtilizzabili: utilizzabili,
    board: { generatoIl: board.meta && board.meta.generatedAt, righe: mercati.length, ammissibili: ammissibili.length, esclusiPerMotivo: [...perMotivo.entries()] },
    distribuzioni,
    mercati: righe,
    stime,
    totali: tot,
    totaliPrimiDue: totDue,
    capitaleImpegnabile: +capitaleImpegnato.toFixed(2),
  });
  console.log(`\nscritto ${f}`);
}

main().catch((e) => { console.error('errore:', e.stack || e.message); process.exit(1); });

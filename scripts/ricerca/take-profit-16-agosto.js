#!/usr/bin/env node
'use strict';
/**
 * IL TAKE-PROFIT CHE NON C'E' — quanto valeva davvero uscire, minuto per minuto. SOLA LETTURA.
 *
 * LA DOMANDA DELL'OPERATORE: «ieri vedevo un gain sulla dashboard e non e' stato incassato».
 * La domanda vera dietro quella frase e' se il gain fosse INCASSABILE, cioe' se esistesse un prezzo
 * a cui qualcuno ci avrebbe davvero comprato la posizione — non un mid, che e' la media fra due
 * prezzi di cui uno solo e' colpibile.
 *
 * COSA MISURA, E CON QUALE ROUTE
 * Il giornale `data/mid-history-<giorno>.jsonl` (agent34) registra il libro del token **YES** e basta
 * (`tokenIdYes` + `levels[]`). Quindi le due posizioni si misurano con due strade diverse, e nessuna
 * delle due e' un'approssimazione del libro mancante:
 *
 *   • POSIZIONE SU YES  ⇒ vendita diretta: si cammina la scala dei BID, che e' registrata.
 *   • POSIZIONE SU NO   ⇒ **coppia + merge**: si comprano `size` share di YES camminando la scala
 *     degli ASK e si fonde la coppia, che rende $1/share. Ricavo per share = `1 - askMedio`.
 *     Non e' un surrogato del libro NO: e' la strada che il bot HA GIA' (auto-close Livello 1,
 *     §4.6), e il suo prezzo e' interamente registrato.
 *
 * ⚠ DUE LIMITI DEL DATO, DICHIARATI, NON AGGIRATI
 *   ① `levels[]` nasce da `reward-layers.levelsInBand`: copre **solo i tick dentro la banda
 *      premiante** e somma **solo gli ordini di size >= minSize** (`o.size >= cutoff`,
 *      lib/reward-layers.js:116). Quindi SOTTOSTIMA la profondita' davvero colpibile — un ordine da
 *      30 share al miglior prezzo e' invisibile a questo conteggio ma un taker lo prende benissimo.
 *   ② Per questo ogni istante porta DUE numeri e non uno:
 *        - `tetto`  — tutta la size al miglior prezzo (`bestBid`/`bestAsk`, registrati senza filtro):
 *                     il massimo teorico, vero solo se il top of book bastava da solo;
 *        - `cammino`— la scala percorsa livello per livello sulle sole size qualificanti:
 *                     il pavimento, perche' la profondita' vera e' >= di quella contata.
 *      Il valore realizzabile sta **fra i due**. Se anche il TETTO al momento migliore non batte il
 *      carico, la conclusione «non c'era gain incassabile» non dipende da quale dei due si creda.
 *
 * TERZA PROVA, INDIPENDENTE DAL LIBRO: `data/trade-tape-<giorno>.jsonl` porta gli scambi VERI per
 * tokenId. Una stampa a prezzo p e' la prova che a p si e' scambiato davvero — non ha bisogno di
 * nessun modello. Serve a controllare le due stime, non a sostituirle.
 *
 * Scrive in data/ricerca/ e niente altro.
 *
 * Uso:  node scripts/ricerca/take-profit-16-agosto.js [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const OUT_DIR = path.join(DATA, 'ricerca');
const GIORNO = process.argv[2] || '2026-08-16';
const OUT = path.join(OUT_DIR, `take-profit-${GIORNO}.json`);

const c = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const usd = (x) => (x == null ? null : Math.round(x * 100) / 100);

/* ── Gli episodi di fill, letti dal giornale maker ───────────────────────────────────────────────
 * `modalita-chiusura-ingresso` marca l'istante e il lato; i record `merge-livello-*` portano
 * `sizePosseduta` e `prezzoCarico` letti dal venue. Si prende la size MASSIMA osservata (il fill puo'
 * arrivare in piu' pezzi) e il primo `prezzoCarico` FINITO E > 0: al primo giro il venue non ha
 * ancora consolidato il prezzo medio e scrive 0, che non e' un carico ma un «non ho letto». */
async function leggiEpisodi() {
  const ep = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(DATA, 'polymarket-maker-audit.jsonl')),
    crlfDelay: Infinity,
  });
  for await (const riga of rl) {
    let o; try { o = JSON.parse(riga); } catch { continue; }
    if (o.op !== 'auto-close' || !o.marketRef || !/^cid_/.test(o.marketRef)) continue;
    const ob = o.observed || {};
    const book = ob.book || (o.outcome === 'modalita-chiusura-ingresso' ? ob.book : null);
    if (!book) continue;
    const giorno = new Date(o.ts).toISOString().slice(0, 10);
    if (giorno !== GIORNO) continue;

    const k = `${o.marketRef}:${book}`;
    if (!ep.has(k)) ep.set(k, {
      marketId: '0x' + o.marketRef.slice(4), book,
      daMs: null, aMs: null, size: 0, prezzoCarico: null, campioniCarico: [],
    });
    const e = ep.get(k);
    const s = Number(ob.sizePosseduta ?? ob.sizeFillata);
    if (Number.isFinite(s) && s > e.size) e.size = s;
    if (o.outcome === 'modalita-chiusura-ingresso' && e.daMs == null) e.daMs = o.ts;
    const pc = Number(ob.prezzoCarico);
    if (Number.isFinite(pc) && pc > 0) { e.campioniCarico.push(pc); if (e.prezzoCarico == null) e.prezzoCarico = pc; }
    e.aMs = o.ts;
  }
  return [...ep.values()].filter((e) => e.daMs != null && e.size > 0);
}

/* ── Il libro nella finestra, dal giornale di agent34 ─────────────────────────────────────────── */
async function leggiLibro(marketId, daMs, aMs) {
  const f = path.join(DATA, `mid-history-${GIORNO}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const riga of rl) {
    if (riga.indexOf(marketId) < 0) continue;          // filtro a stringa: evita di parsare 113k righe
    let o; try { o = JSON.parse(riga); } catch { continue; }
    if (o.marketId !== marketId) continue;
    const t = Date.parse(o.ts);
    if (!(t >= daMs && t <= aMs)) continue;
    out.push(o);
  }
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return out;
}

/** Cammina una scala per `size`. Ritorna il prezzo medio e quanto si e' riusciti a coprire.
 *  ⚠ Non estrapola mai oltre la profondita' registrata: se la scala finisce, `coperta < size` e il
 *  chiamante lo dichiara invece di inventare un livello in piu'. */
function cammina(livelli, size, campoPrezzo, campoSize) {
  let resta = size, costo = 0, coperta = 0;
  for (const l of livelli || []) {
    const p = Number(l[campoPrezzo]), q = Number(l[campoSize]);
    if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) continue;
    const preso = Math.min(resta, q);
    costo += preso * p; coperta += preso; resta -= preso;
    if (resta <= 1e-9) break;
  }
  return { medio: coperta > 0 ? costo / coperta : null, coperta, completa: resta <= 1e-9 };
}

/* ── Gli scambi veri sul token, nella finestra ────────────────────────────────────────────────── */
async function leggiTape(tokenId, daMs, aMs) {
  const f = path.join(DATA, `trade-tape-${GIORNO}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const riga of rl) {
    if (riga.indexOf(tokenId) < 0) continue;
    let o; try { o = JSON.parse(riga); } catch { continue; }
    if (o.tokenId !== tokenId) continue;
    if (!(o.tsVenueMs >= daMs && o.tsVenueMs <= aMs)) continue;
    out.push({ ts: o.tsVenueIso, side: o.side, price: o.price, size: o.size });
  }
  return out;
}

/* ── Quel che il pannello mostrava: il campionamento dell'osservatore ─────────────────────────── */
function leggiOsservatore(marketId, daMs, aMs) {
  const f = path.join(DATA, 'osservatore', `campioni-${GIORNO}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const riga of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!riga || riga.indexOf(marketId) < 0) continue;
    let o; try { o = JSON.parse(riga); } catch { continue; }
    if (!(o.at >= daMs && o.at <= aMs)) continue;
    const p = (o.posizioniPerMercato || []).find((x) => x.conditionId === marketId);
    if (p) out.push({ ts: o.atIso, valoreUsd: p.valoreUsd, gambe: p.gambe, coppiaCompleta: p.coppiaCompleta });
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const board = JSON.parse(fs.readFileSync(path.join(DATA, 'liquidity-rewards.json'), 'utf8'));
  const righeBoard = Array.isArray(board) ? board : (board.markets || board.rows || []);
  const perId = new Map(righeBoard.map((r) => [r.conditionId, r]));

  const episodi = await leggiEpisodi();
  const referto = { giorno: GIORNO, generatoIl: new Date().toISOString(), episodi: [] };

  for (const e of episodi) {
    const m = perId.get(e.marketId) || {};
    const tokenPosseduto = e.book === 'no' ? m.tokenIdNo : m.tokenId;
    const libro = await leggiLibro(e.marketId, e.daMs, e.aMs);
    const tape = tokenPosseduto ? await leggiTape(tokenPosseduto, e.daMs, e.aMs) : [];
    const oss = leggiOsservatore(e.marketId, e.daMs, e.aMs);

    const costoUsd = e.prezzoCarico != null ? e.size * e.prezzoCarico : null;
    const serie = [];
    for (const s of libro) {
      let tetto = null, camm = null, completa = null, note = null;
      if (e.book === 'yes') {
        // vendita diretta: si colpiscono i BID del libro YES
        if (Number.isFinite(s.bestBid)) tetto = e.size * s.bestBid;
        const w = cammina(s.levels, e.size, 'bidPrice', 'bidSizeAtLevel');
        if (w.medio != null) { camm = w.coperta * w.medio; completa = w.completa; }
        note = 'vendita diretta sul libro YES';
      } else {
        // coppia + merge: si comprano gli ASK di YES, la coppia rende $1/share
        if (Number.isFinite(s.bestAsk)) tetto = e.size * (1 - s.bestAsk);
        const w = cammina(s.levels, e.size, 'askPrice', 'askSizeAtLevel');
        if (w.medio != null) { camm = w.coperta * (1 - w.medio); completa = w.completa; }
        note = 'acquisto della gamba YES + merge della coppia ($1/share)';
      }
      serie.push({
        ts: s.ts, bestBid: s.bestBid, bestAsk: s.bestAsk, mid: s.adjMid,
        ricavoTettoUsd: usd(tetto), ricavoCamminoUsd: usd(camm), camminoCompleto: completa,
        margineTettoUsd: costoUsd != null && tetto != null ? usd(tetto - costoUsd) : null,
        note,
      });
    }

    const conTetto = serie.filter((x) => x.ricavoTettoUsd != null);
    const migliore = conTetto.length
      ? conTetto.reduce((a, b) => (b.ricavoTettoUsd > a.ricavoTettoUsd ? b : a)) : null;
    const conCammino = serie.filter((x) => x.ricavoCamminoUsd != null && x.camminoCompleto);
    const miglioreCammino = conCammino.length
      ? conCammino.reduce((a, b) => (b.ricavoCamminoUsd > a.ricavoCamminoUsd ? b : a)) : null;

    /* Quel che il pannello dichiarava al suo massimo — il numero che l'operatore ha visto.
     * ⚠ IL CONFRONTO VALE SOLO A GAMBE PARI, e la prima stesura di questo script sbagliava proprio
     * qui: `costoUsd` copre la SOLA gamba riempita, mentre `valoreUsd` dell'osservatore somma TUTTE
     * le gambe del mercato. Su una coppia completa il confronto dichiarava «+$26,27 di guadagno
     * apparente» semplicemente perche' misurava due gambe di valore contro una di costo. Quando le
     * gambe non corrispondono il guadagno apparente e' `null` e si dice perche': un numero che non
     * si puo' calcolare non si stima. */
    const ossMax = oss.length ? oss.reduce((a, b) => (b.valoreUsd > a.valoreUsd ? b : a)) : null;
    const gambePari = ossMax != null && ossMax.gambe === 1;
    const guadagnoApparente = ossMax && costoUsd != null && gambePari ? usd(ossMax.valoreUsd - costoUsd) : null;
    const guadagnoNonConfrontabile = ossMax && !gambePari
      ? `il pannello somma ${ossMax.gambe} gambe, il carico misurato ne copre 1: non confrontabili`
      : null;

    referto.episodi.push({
      marketId: e.marketId, titolo: m.question || m.groupItemTitle || null, book: e.book,
      tokenPosseduto: tokenPosseduto || null,
      daIso: new Date(e.daMs).toISOString(), aIso: new Date(e.aMs).toISOString(),
      durataMin: Math.round((e.aMs - e.daMs) / 60000),
      size: e.size, prezzoCarico: e.prezzoCarico, costoUsd: usd(costoUsd),
      campioniLibro: serie.length, campioniTape: tape.length,
      pannelloMassimo: ossMax ? { ts: ossMax.ts, valoreUsd: usd(ossMax.valoreUsd), gambe: ossMax.gambe, coppiaCompleta: ossMax.coppiaCompleta } : null,
      pannelloGuadagnoApparenteUsd: guadagnoApparente,
      pannelloGuadagnoNonConfrontabile: guadagnoNonConfrontabile,
      miglioreTetto: migliore ? {
        ts: migliore.ts, ricavoUsd: migliore.ricavoTettoUsd,
        margineUsd: migliore.margineTettoUsd, bestBid: migliore.bestBid, bestAsk: migliore.bestAsk,
      } : null,
      miglioreCammino: miglioreCammino ? {
        ts: miglioreCammino.ts, ricavoUsd: miglioreCammino.ricavoCamminoUsd,
        margineUsd: costoUsd != null ? usd(miglioreCammino.ricavoCamminoUsd - costoUsd) : null,
      } : null,
      camminiCompleti: conCammino.length,
      /* LA RIGA CHE DECIDE, e non e' il massimo: quanti istanti offrivano davvero un'uscita in
       * guadagno. Il massimo da solo direbbe «si e' andati vicini»; il conteggio dice se la finestra
       * e' MAI esistita. Si conta sul TETTO, cioe' sull'ipotesi piu' generosa possibile. */
      istantiInGuadagno: costoUsd == null ? null : conTetto.filter((x) => x.ricavoTettoUsd > costoUsd).length,
      istantiInPareggio: costoUsd == null ? null : conTetto.filter((x) => Math.abs(x.ricavoTettoUsd - costoUsd) < 0.005).length,
      istantiInPerdita: costoUsd == null ? null : conTetto.filter((x) => x.ricavoTettoUsd < costoUsd - 0.005).length,
      tape, serie,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  // ── Referto a schermo ─────────────────────────────────────────────────────────────────────────
  for (const e of referto.episodi) {
    console.log('\n' + '='.repeat(100));
    console.log(`${e.titolo || e.marketId}`);
    console.log(`lato ${e.book.toUpperCase()} · ${e.size} share a $${e.prezzoCarico}/share ⇒ costo $${e.costoUsd}`);
    console.log(`finestra ${e.daIso.slice(11, 19)} → ${e.aIso.slice(11, 19)} (${e.durataMin} min) · ${e.campioniLibro} campioni di libro · ${e.campioniTape} scambi veri`);
    if (e.pannelloMassimo) {
      const coda = e.pannelloGuadagnoApparenteUsd != null
        ? `  ⇒ guadagno APPARENTE ${e.pannelloGuadagnoApparenteUsd >= 0 ? '+' : ''}$${e.pannelloGuadagnoApparenteUsd}`
        : `  ⇒ guadagno apparente non calcolabile: ${e.pannelloGuadagnoNonConfrontabile}`;
      console.log(`\n  IL PANNELLO al suo massimo: $${e.pannelloMassimo.valoreUsd} alle ${e.pannelloMassimo.ts.slice(11, 19)}` + coda);
    }
    if (e.miglioreTetto) {
      console.log(`  TETTO (tutta la size al miglior prezzo, mai raggiungibile meglio di cosi'):`);
      console.log(`     $${e.miglioreTetto.ricavoUsd} alle ${e.miglioreTetto.ts.slice(11, 19)}`
        + `  ⇒ margine ${e.miglioreTetto.margineUsd >= 0 ? '+' : ''}$${e.miglioreTetto.margineUsd}`
        + `   (bid ${e.miglioreTetto.bestBid} / ask ${e.miglioreTetto.bestAsk})`);
    }
    console.log(`  ISTANTI: ${e.istantiInGuadagno} in guadagno · ${e.istantiInPareggio} in pareggio · ${e.istantiInPerdita} in perdita`
      + `   (su ${e.campioniLibro} campioni, misurati sul TETTO)`);
    console.log(`  CAMMINO sulla scala qualificante: ${e.camminiCompleti} campioni su ${e.campioniLibro} coprivano l'intera size`);
    if (e.miglioreCammino) {
      console.log(`     migliore $${e.miglioreCammino.ricavoUsd} alle ${e.miglioreCammino.ts.slice(11, 19)}`
        + `  ⇒ margine ${e.miglioreCammino.margineUsd >= 0 ? '+' : ''}$${e.miglioreCammino.margineUsd}`);
    }
    if (e.tape.length) {
      console.log(`  SCAMBI VERI sul token posseduto (prova indipendente dal libro):`);
      for (const t of e.tape) console.log(`     ${t.ts.slice(11, 19)}  ${t.side.padEnd(4)} ${t.price}  ×${t.size}`);
    } else {
      console.log(`  SCAMBI VERI sul token posseduto: NESSUNO nella finestra`);
    }
  }
  console.log(`\nscritto ${path.relative(ROOT, OUT)}`);
})();

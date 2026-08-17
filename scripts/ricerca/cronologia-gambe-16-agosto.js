#!/usr/bin/env node
'use strict';
/**
 * COSA E' SUCCESSO AGLI ORDINI DI LIQUIDITA' IL 16 AGOSTO — sola lettura, ricostruito dagli EVENTI.
 *
 * LA DOMANDA DELL'OPERATORE (17 agosto 2026): «ricostruito dal giornale e dagli eventi del venue,
 * non da quello che il maker dichiarava». Questo script non legge nessuno stato riassunto — non
 * `data/venue-positions.json`, non i referti dei giri, non i piani salvati. Legge SOLO gli eventi
 * di nascita e di morte degli ordini, e ricostruisce da quelli l'insieme degli ordini vivi istante
 * per istante. Se l'insieme ricostruito e' diverso da quello che un referto dichiarava, ha ragione
 * questo, perche' e' fatto di fatti singoli e non di un riassunto.
 *
 * ⚠ PERCHE' NON SI USA `polymarket-clob-audit.jsonl`, che sarebbe la fonte piu' diretta: quel
 * giornale porta 75.077 `listOpenOrders` del 16 agosto — la fotografia dello stato VERO al venue —
 * ma il `marketId` e' **redatto** (`0x[redacted-64hex]`) e la risposta conserva il solo `count`.
 * Dice quanti ordini c'erano, non su quale mercato: inutilizzabile per una cronologia per mercato.
 * Il giornale maker invece porta `marketRef: cid_<hex>` in chiaro sulle nascite. Si usa quello, e
 * i `count` del venue servono da RISCONTRO aggregato (blocco 4-bis).
 *
 * COSA CONTA COME «GAMBA»: un ordine VIVO a riposo su un book (yes / no) di un mercato. Copertura
 * piena = almeno un ordine vivo su ENTRAMBI i book nello stesso istante. E' la definizione operativa
 * di «faccio liquidita' vera su due lati», che e' cio' che il venue premia.
 *
 * LE MORTI, e da dove si leggono:
 *   · `manual-cancel | ok`                    → cancellazione nostra, riuscita
 *   · `order-vanished | expired`              → morto di GTD
 *   · `order-vanished | cancelled-by-system`  → cancellato da noi (riscontro incrociato)
 *   · `order-vanished | cancelled-externally` → sparito senza che lo abbiamo cancellato
 *   · `manual-replace | sent`                 → il vecchio muore e nasce il nuovo, ATOMICO
 *   · fill                                    → riempito (safety-fills, kind:'fill')
 *
 * ⚠ IL SUCCESSORE VA SEGUITO, O SI CONTA UNA MORTE CHE NON C'E' STATA: un riprezzo e' una
 * cancellazione seguita da un piazzamento, e se si guardano solo le morti sembra che la gamba sia
 * sparita. La gamba muore quando muore l'ULTIMO anello della catena senza un successore.
 *
 * Scrive in data/ricerca/ e niente altro. Nessuna scrittura fuori da li'.
 *
 * Uso:  node scripts/ricerca/cronologia-gambe-16-agosto.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const GIORNO = process.env.GIORNO || '2026-08-16';
const OUT = path.join(DATA, 'ricerca', `cronologia-gambe-${GIORNO}.json`);

const iso = (ms) => new Date(ms).toISOString();
const hhmm = (ms) => iso(ms).slice(11, 19);
const min = (ms) => Math.round(ms / 600) / 100;   // ms → minuti, 2 decimali

/** Legge un jsonl riga per riga, filtrando sul giorno. */
async function scorri(file, cb) {
  if (!fs.existsSync(file)) return;
  for await (const l of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const ts = Number(o.ts);
    if (!Number.isFinite(ts)) continue;
    if (!iso(ts).startsWith(GIORNO)) continue;
    cb(o, ts);
  }
}

(async () => {
  // ── 1 · NASCITE ────────────────────────────────────────────────────────────────────────────────
  // `manual-place | sent` e' l'unico evento che porta insieme orderId, marketRef IN CHIARO, book,
  // lato, prezzo e size. E' la spina dorsale di tutta la ricostruzione.
  const ordini = new Map();      // orderId → { nato, mercato, book, side, price, size, source, morto, causa, successore }
  const perMercato = new Map();  // cid → { eventi:[], titolo }
  const rifiuti = [];            // piazzamenti RIFIUTATI: gambe mai nate
  const rinnoviFermati = [];     // auto-reprice | anomalia-rinnovo-fermato
  const sostituzioni = new Map();// vecchioId → nuovoId
  const morti = new Map();       // orderId → { ts, causa, dettaglio }
  const coperturaChiamate = [];  // tracce della copertura continua

  await scorri(path.join(DATA, 'polymarket-maker-audit.jsonl'), (o, ts) => {
    const cid = typeof o.marketRef === 'string' && o.marketRef.startsWith('cid_')
      ? o.marketRef.slice(4) : null;

    if (o.op === 'manual-place' && o.outcome === 'sent' && o.orderId) {
      ordini.set(o.orderId, {
        orderId: o.orderId, nato: ts, mercato: cid,
        book: o.requested && o.requested.book, side: o.requested && o.requested.side,
        price: o.requested && o.requested.price, size: o.requested && o.requested.size,
        notional: o.requested && o.requested.notionalUsd,
        source: o.source, morto: null, causa: null, successore: null,
      });
      if (cid && !perMercato.has(cid)) perMercato.set(cid, { eventi: [] });
    }

    // Piazzamenti RIFIUTATI — la classe «mai nata perche' il piano non l'ha finanziata» e tutte le
    // altre porte chiuse. Si tengono TUTTI i gate, cosi' la classifica del blocco 5 e' misurata e
    // non scelta a mano.
    if ((o.op === 'manual-place' || o.op === 'postOrder') && typeof o.outcome === 'string'
      && o.outcome.startsWith('reject')) {
      rifiuti.push({ ts, mercato: cid, gate: o.gate || o.outcome, book: o.requested && o.requested.book,
        side: o.requested && o.requested.side, notional: o.requested && o.requested.notionalUsd,
        source: o.source, reason: (o.reason || '').slice(0, 260) });
    }

    // Il riprezzo: il vecchio muore, il nuovo nasce. Va seguito o si conta una morte inesistente.
    if (o.op === 'manual-replace' && o.outcome === 'sent') {
      const vecchio = o.requested && o.requested.orderId;
      const nuovo = o.response && o.response.newOrderId;
      if (vecchio && nuovo) sostituzioni.set(vecchio, nuovo);
    }
    // Un replace che cancella e NON ripiazza e' una gamba persa, e il gate dice perche'.
    if (o.op === 'manual-replace' && o.response && o.response.oldCancelled === true
      && o.response.replaced === false) {
      const vecchio = o.requested && o.requested.orderId;
      if (vecchio) morti.set(vecchio, { ts, causa: 'riprezzo-cancella-e-non-ripiazza',
        dettaglio: o.response.gate || o.outcome });
    }

    if (o.op === 'manual-cancel' && o.outcome === 'ok') {
      const id = o.requested && o.requested.orderId;
      if (id && !morti.has(id)) morti.set(id, { ts, causa: 'cancellato-da-noi', dettaglio: o.source });
    }
    if (o.op === 'order-vanished') {
      const id = o.orderId;
      if (id && !morti.has(id)) morti.set(id, { ts, causa: o.outcome, dettaglio: (o.reason || '').slice(0, 200) });
    }

    // Il rinnovo fermato: l'ordine sta per scadere e il motore rifiuta di rimetterlo. E' la causa
    // per cui una gamba muore di GTD «pur essendo sorvegliata».
    if (o.op === 'auto-reprice' && o.outcome === 'anomalia-rinnovo-fermato') {
      rinnoviFermati.push({ ts, mercato: cid, reason: (o.reason || '').slice(0, 200),
        gate: o.gate || null, observed: o.observed || null });
    }
    // Le cancellazioni VOLUTE del riprezzo, con il loro motivo dichiarato.
    if (o.op === 'auto-reprice' && /mid-stantio-cancellato|cecita-timeout/.test(String(o.outcome))) {
      const id = (o.observed && o.observed.orderId) || o.orderId;
      if (id && !morti.has(id)) morti.set(id, { ts, causa: 'mid-stantio', dettaglio: o.outcome });
    }

    // La copertura continua: e' stata chiamata? cosa ha deciso?
    if (/copertura/i.test(String(o.op)) || /copertura/i.test(String(o.outcome))) {
      coperturaChiamate.push({ ts, op: o.op, outcome: o.outcome, mercato: cid,
        reason: (o.reason || '').slice(0, 240) });
    }
    if (o.op === 'rimpiazzo-gamba') {
      coperturaChiamate.push({ ts, op: o.op, outcome: o.outcome, mercato: cid,
        reason: (o.reason || '').slice(0, 240) });
    }
  });

  // I fill, dall'unico giornale che li registra come tali.
  await scorri(path.join(DATA, 'safety-fills.jsonl'), (o, ts) => {
    if (o.kind !== 'fill' || !o.orderId) return;
    morti.set(o.orderId, { ts, causa: 'riempito', dettaglio: `${o.filledSize}@${o.filledPrice}` });
  });

  // ── 2 · CHIUSURA DELLE CATENE ──────────────────────────────────────────────────────────────────
  for (const [id, o] of ordini) {
    const m = morti.get(id);
    if (m) { o.morto = m.ts; o.causa = m.causa; o.dettaglio = m.dettaglio; }
    const succ = sostituzioni.get(id);
    if (succ) { o.successore = succ; if (!o.causa) { o.causa = 'sostituito'; } }
  }
  // Un ordine mai visto morire e' vivo a fine giornata: si tronca a mezzanotte.
  const FINE = Date.parse(`${GIORNO}T23:59:59.999Z`);
  const INIZIO = Date.parse(`${GIORNO}T00:00:00.000Z`);
  for (const o of ordini.values()) if (o.morto == null) { o.morto = FINE; o.causa = o.causa || 'vivo-a-fine-giornata'; }

  // ── 3 · LA LINEA DEL TEMPO PER MERCATO ─────────────────────────────────────────────────────────
  // Si costruisce l'insieme degli ordini vivi campionando a ogni EVENTO (nascita o morte): fra due
  // eventi consecutivi lo stato non puo' cambiare, quindi non serve campionare a tempo fisso e non
  // si introduce nessun errore di discretizzazione.
  const perCid = new Map();
  for (const o of ordini.values()) {
    if (!o.mercato) continue;
    if (!perCid.has(o.mercato)) perCid.set(o.mercato, []);
    perCid.get(o.mercato).push(o);
  }

  const mercati = [];
  for (const [cid, lista] of perCid) {
    const punti = new Set();
    for (const o of lista) { punti.add(o.nato); punti.add(o.morto); }
    const t = [...punti].sort((a, b) => a - b);
    const primo = t[0], ultimo = t[t.length - 1];

    // Intervalli con il conteggio delle gambe (book distinti con almeno un ordine vivo).
    const fasi = [];
    for (let i = 0; i < t.length - 1; i++) {
      const a = t[i], b = t[i + 1];
      const vivi = lista.filter((o) => o.nato <= a && o.morto > a);
      const books = new Set(vivi.map((o) => o.book).filter(Boolean));
      fasi.push({ da: a, a: b, durataMs: b - a, gambe: books.size,
        books: [...books].sort().join('+') || '—', ordini: vivi.length });
    }
    // Fasi contigue con lo stesso numero di gambe si fondono: la cronologia dev'essere leggibile.
    const fuse = [];
    for (const f of fasi) {
      const u = fuse[fuse.length - 1];
      if (u && u.books === f.books) { u.a = f.a; u.durataMs += f.durataMs; }
      else fuse.push({ ...f });
    }

    let msDue = 0, msUna = 0, msZero = 0;
    for (const f of fuse) {
      if (f.gambe >= 2) msDue += f.durataMs;
      else if (f.gambe === 1) msUna += f.durataMs;
      else msZero += f.durataMs;
    }
    const finestra = ultimo - primo;

    // I passaggi 2 → 1: l'istante esatto che l'operatore ha chiesto di vedere.
    const cadute = [];
    for (let i = 1; i < fuse.length; i++) {
      if (fuse[i - 1].gambe >= 2 && fuse[i].gambe === 1) {
        // Chi e' morto in quell'istante?
        const morti1 = lista.filter((o) => Math.abs(o.morto - fuse[i].da) < 1500);
        cadute.push({
          quando: iso(fuse[i].da), ora: hhmm(fuse[i].da),
          restaIlBook: fuse[i].books,
          durataGambaSingolaMin: min(fuse[i].durataMs),
          tornata: i + 1 < fuse.length && fuse[i + 1].gambe >= 2 ? iso(fuse[i + 1].da) : null,
          morte: morti1.map((o) => ({ orderId: o.orderId.slice(0, 12) + '…', book: o.book,
            price: o.price, size: o.size, causa: o.causa, dettaglio: o.dettaglio || null,
            successore: o.successore ? o.successore.slice(0, 12) + '…' : null })),
        });
      }
    }

    mercati.push({
      cid, cidBreve: cid.slice(0, 10) + '…',
      ordiniTotali: lista.length,
      primoOrdine: iso(primo), ultimoEvento: iso(ultimo),
      finestraOre: +(finestra / 3_600_000).toFixed(2),
      minutiDueGambe: min(msDue), minutiUnaGamba: min(msUna), minutiZero: min(msZero),
      percentualeCoperturaPiena: finestra > 0 ? +(100 * msDue / finestra).toFixed(1) : null,
      cadute,
      fasi: fuse.map((f) => ({ da: hhmm(f.da), a: hhmm(f.a), min: min(f.durataMs),
        gambe: f.gambe, books: f.books, ordini: f.ordini })),
    });
  }
  mercati.sort((a, b) => b.minutiUnaGamba - a.minutiUnaGamba);

  // ── 4 · LE CAUSE, PESATE IN MINUTI DI GAMBA SINGOLA ────────────────────────────────────────────
  // Non «quante volte e' successo» ma «quanti minuti di gamba singola ha prodotto»: e' la domanda
  // dell'operatore, ed e' l'unica che ordina correttamente gli interventi.
  const perCausa = new Map();
  for (const m of mercati) {
    for (const c of m.cadute) {
      for (const mo of c.morte) {
        // Un ordine con un successore non ha lasciato scoperta la gamba: lo si registra a parte.
        const k = mo.successore ? `${mo.causa} (con successore)` : mo.causa;
        if (!perCausa.has(k)) perCausa.set(k, { causa: k, episodi: 0, minuti: 0, mercati: new Set(), esempi: [] });
        const e = perCausa.get(k);
        e.episodi++;
        e.minuti += c.durataGambaSingolaMin / c.morte.length;   // ripartito se piu' morti insieme
        e.mercati.add(m.cidBreve);
        if (e.esempi.length < 3) e.esempi.push(`${m.cidBreve} ${c.ora} ${mo.book} ${mo.dettaglio || ''}`.trim());
      }
    }
  }
  const cause = [...perCausa.values()].map((e) => ({ ...e, minuti: +e.minuti.toFixed(1),
    mercati: e.mercati.size, esempi: e.esempi })).sort((a, b) => b.minuti - a.minuti);

  // I rifiuti al piazzamento: gambe MAI NATE, raggruppate per gate.
  const perGate = new Map();
  for (const r of rifiuti) {
    if (!perGate.has(r.gate)) perGate.set(r.gate, { gate: r.gate, n: 0, mercati: new Set(), esempio: r.reason });
    const e = perGate.get(r.gate); e.n++; if (r.mercato) e.mercati.add(r.mercato.slice(0, 10));
  }
  const gate = [...perGate.values()].map((e) => ({ gate: e.gate, n: e.n, mercati: e.mercati.size,
    esempio: e.esempio })).sort((a, b) => b.n - a.n);

  // ── 4-bis · RISCONTRO AGGREGATO SUL VENUE ──────────────────────────────────────────────────────
  // `listOpenOrders` porta il `count` VERO al venue. Il marketId e' redatto, quindi non si puo'
  // attribuire — ma la distribuzione dei conteggi dice quanti ordini c'erano davvero, e serve a
  // verificare che la ricostruzione qui sopra non stia inventando ordini che il venue non aveva.
  const conteggi = new Map();
  await scorri(path.join(DATA, 'polymarket-clob-audit.jsonl'), (o) => {
    if (o.op !== 'listOpenOrders' || !o.response) return;
    const c = Number(o.response.count);
    if (!Number.isFinite(c)) return;
    conteggi.set(c, (conteggi.get(c) || 0) + 1);
  });
  const tot = [...conteggi.values()].reduce((a, b) => a + b, 0);
  const riscontro = [...conteggi].sort((a, b) => a[0] - b[0])
    .map(([c, n]) => ({ ordiniVivi: c, campioni: n, quota: +(100 * n / tot).toFixed(1) }));

  // ── 5 · IL TOTALE DELLA GIORNATA ───────────────────────────────────────────────────────────────
  const totDue = mercati.reduce((a, m) => a + m.minutiDueGambe, 0);
  const totUna = mercati.reduce((a, m) => a + m.minutiUnaGamba, 0);
  const totZero = mercati.reduce((a, m) => a + m.minutiZero, 0);

  const referto = {
    generatoIl: new Date().toISOString(), giorno: GIORNO,
    fonti: ['data/polymarket-maker-audit.jsonl (nascite/morti, marketRef in chiaro)',
      'data/safety-fills.jsonl (fill)',
      'data/polymarket-clob-audit.jsonl (riscontro aggregato: marketId REDATTO)'],
    ordiniNati: ordini.size,
    mercatiConOrdini: mercati.length,
    totale: {
      oreDueGambe: +(totDue / 60).toFixed(2), oreUnaGamba: +(totUna / 60).toFixed(2),
      oreZero: +(totZero / 60).toFixed(2),
      percentualeCoperturaPiena: totDue + totUna + totZero > 0
        ? +(100 * totDue / (totDue + totUna + totZero)).toFixed(1) : null,
    },
    cause, gate, mercati,
    rinnoviFermati: {
      n: rinnoviFermati.length,
      perMercato: [...rinnoviFermati.reduce((m, r) => (m.set(r.mercato ? r.mercato.slice(0, 10) : '?',
        (m.get(r.mercato ? r.mercato.slice(0, 10) : '?') || 0) + 1), m), new Map())]
        .sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ mercato: m, n })),
      motivi: [...rinnoviFermati.reduce((m, r) => {
        const k = (r.reason.match(/:\s*([a-z-]+)\s*$/) || [null, r.reason.slice(0, 60)])[1];
        return m.set(k, (m.get(k) || 0) + 1);
      }, new Map())].sort((a, b) => b[1] - a[1]).map(([motivo, n]) => ({ motivo, n })),
      primo: rinnoviFermati.length ? iso(rinnoviFermati[0].ts) : null,
      ultimo: rinnoviFermati.length ? iso(rinnoviFermati[rinnoviFermati.length - 1].ts) : null,
    },
    copertura: {
      chiamate: coperturaChiamate.length,
      esiti: [...coperturaChiamate.reduce((m, c) => m.set(`${c.op} | ${c.outcome}`,
        (m.get(`${c.op} | ${c.outcome}`) || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ esito: k, n })),
      esempi: coperturaChiamate.slice(0, 6).map((c) => ({ ora: hhmm(c.ts), op: c.op,
        outcome: c.outcome, reason: c.reason })),
    },
    riscontroVenue: { campioni: tot, distribuzione: riscontro },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  // ── STAMPA ─────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n════ CRONOLOGIA GAMBE — ${GIORNO} ════`);
  console.log(`${ordini.size} ordini nati · ${mercati.length} mercati con ordini\n`);
  console.log(`COPERTURA PIENA (due gambe vive): ${referto.totale.oreDueGambe} h`
    + ` · UNA GAMBA: ${referto.totale.oreUnaGamba} h · ZERO: ${referto.totale.oreZero} h`
    + `  ⇒ ${referto.totale.percentualeCoperturaPiena}%\n`);

  console.log('── per mercato ──');
  console.log('mercato'.padEnd(14) + 'ordini'.padStart(7) + 'finestra'.padStart(10)
    + '2 gambe'.padStart(10) + '1 gamba'.padStart(10) + 'cadute'.padStart(8) + '  %piena');
  for (const m of mercati) {
    console.log(m.cidBreve.padEnd(14) + String(m.ordiniTotali).padStart(7)
      + (m.finestraOre + 'h').padStart(10) + (m.minutiDueGambe + 'm').padStart(10)
      + (m.minutiUnaGamba + 'm').padStart(10) + String(m.cadute.length).padStart(8)
      + '   ' + m.percentualeCoperturaPiena + '%');
  }

  console.log('\n── cause, pesate in MINUTI di gamba singola ──');
  console.log('causa'.padEnd(42) + 'episodi'.padStart(8) + 'minuti'.padStart(9) + 'mercati'.padStart(9));
  for (const c of cause) {
    console.log(c.causa.slice(0, 41).padEnd(42) + String(c.episodi).padStart(8)
      + String(c.minuti).padStart(9) + String(c.mercati).padStart(9));
  }

  console.log('\n── gambe MAI NATE: rifiuti al piazzamento, per gate ──');
  for (const g of gate.slice(0, 14)) console.log(String(g.n).padStart(6), g.gate, `(${g.mercati} mercati)`);

  console.log(`\n── rinnovi fermati: ${referto.rinnoviFermati.n} ──`);
  for (const m of referto.rinnoviFermati.motivi.slice(0, 8)) console.log(String(m.n).padStart(6), m.motivo);

  console.log(`\n── copertura continua: ${referto.copertura.chiamate} tracce ──`);
  for (const e of referto.copertura.esiti) console.log(String(e.n).padStart(6), e.esito);

  console.log('\n── riscontro venue (listOpenOrders, marketId redatto) ──');
  for (const r of riscontro) console.log(`  ${r.ordiniVivi} ordini vivi: ${r.campioni} campioni (${r.quota}%)`);

  console.log(`\nscritto ${path.relative(ROOT, OUT)}`);
})();

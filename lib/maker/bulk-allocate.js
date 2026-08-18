'use strict';
// lib/maker/bulk-allocate.js — place EVERY row of an allocation plan, in sequence, with a cumulative cap.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT. It is a loop over placeManualOrder — nothing more. It
// adds no venue surface, no signing, no second placement path. Every order it places runs the identical
// gate chain a hand order runs (manual ownership, the shared venue-rules guard, the per-order cap, the
// global kill switch, the adapter's own chain, and the exchange's validateOrder()), and lands under the
// same watcher management afterwards: mid chase, band ceiling, GTD renewal, reconciliation.
//
// ─── THE CUMULATIVE CAP IS THE POINT ────────────────────────────────────────────────────────────────
// A single order is checked against the per-order cap by the existing chain. A SEQUENCE is different: ten
// orders each individually under the cap can still add up to far more open exposure than the account is
// allowed. So this tracks the running total itself and STOPS the moment the next order would cross the
// open-notional ceiling — it does not attempt it and let a gate refuse it, because a refusal mid-sequence
// is indistinguishable from a failure and leaves the operator guessing which rows are live.
//
// It stops rather than skipping ahead to a smaller row that would still fit. Reordering an allocation
// silently is a different allocation from the one that was reviewed and confirmed.
//
// ─── EVERY ROW GETS A VERDICT ───────────────────────────────────────────────────────────────────────
// placed / refused / skipped, each with its reason, so the report answers "what is live right now"
// exactly. A bulk action whose failure mode is an unclear partial state is worse than no bulk action.
//
// ─── LE DUE GAMBE DI UN MERCATO VIVONO O MUOIONO INSIEME ────────────────────────────────────────────
// Da quando lib/rewards/plan-to-orders.js emette DUE righe per mercato — un BUY sul libro YES e un BUY
// sul libro NO, che è come si quota il lato ask senza possedere inventario — «una riga rifiutata non
// ferma la sequenza» non basta più. Una gamba piazzata da sola non è mezza posizione: è capitale
// impegnato che, per la formula del venue, matura ZERO fuori dal range [0.10, 0.90] e un terzo dentro.
// È il caso peggiore fra i tre possibili (due gambe, nessuna gamba, una gamba).
//
// Quindi le righe che portano lo stesso `coppia` sono trattate come un'unità:
//   · IL CAP CUMULATIVO si valuta sulla COPPIA INTERA. Se non ci sta tutta, non ne entra metà.
//   · SE UNA GAMBA FALLISCE, quelle già piazzate della stessa coppia vengono CANCELLATE. La direzione
//     è quella che può solo ridurre l'esposizione, e passa dalla stessa corsia cancel-only di sempre.
//   · SE LA CANCELLAZIONE DI RIPRISTINO FALLISCE resta un'esposizione asimmetrica VERA, e allora la
//     sequenza si ferma: non si aggiunge altro capitale sopra a una gamba orfana viva. Il referto la
//     nomina per orderId, perché è l'unica cosa che l'operatore deve andare a guardare a mano.
//
// Una riga SENZA `coppia` resta un'unità a sé — il percorso del pannello manuale, che manda ancora una
// riga per mercato, si comporta esattamente come prima.

const { placeManualOrder, resolveCaps, readEngineState, evaluateManualCapGate, OPERATOR_USER } = require('./manual-order');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');
const killSwitch = require('../safety/kill-switch');

const BULK_SOURCE = 'manual-ui';   // it IS the operator acting, through one button instead of many

/**
 * @param {object} args
 *   rows       [{ marketId, book, side?, price, size, title?, coppia?, gamba? }] — exactly the plan's
 *              rows, in order. Righe con lo stesso `coppia` sono le due gambe di UN mercato e vengono
 *              piazzate o rifiutate insieme (vedi la nota in testa al file).
 *   userId
 *   dryRunOnly if true, validate and report WITHOUT calling the placement path at all (the preview)
 * @param {object} deps  every side effect injectable
 *   cancelOrder({orderId, marketId}) → la corsia cancel-only, usata SOLO per ritirare una gamba
 *              rimasta sola quando la sua controparte è stata rifiutata. Senza di essa una coppia a
 *              metà non è ripristinabile e il referto lo dichiara come `orphan`.
 *   ordersInWindow  quanti ordini sono già stati inviati nella finestra del rate limit da altri.
 *              Assente ⇒ 0: il gate per-ordine resta comunque l'ultima parola.
 * @returns {{ok, at, attempted, placed, refused, skipped, stoppedBy, results, totals}}
 */
async function runBulkAllocation({ rows = [], userId = OPERATOR_USER, dryRunOnly = false, origine = null } = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const place = deps.placeOrder || placeManualOrder;
  const audit = deps.audit || appendMakerAudit;
  const killStatusFn = deps.killStatus || killSwitch.killStatus;
  const capsOf = deps.resolveCaps || ((a, d) => resolveCaps(a, d));
  const results = [];

  const report = (stoppedBy, reason, extra = {}) => {
    const placed = results.filter((r) => r.status === 'placed');
    const refused = results.filter((r) => r.status === 'refused');
    const skipped = results.filter((r) => r.status === 'skipped');
    // Una gamba ritirata perché la sua controparte è stata rifiutata: NON è più sul libro, quindi non
    // conta nell'esposizione — ma non è nemmeno «piazzata», e confonderla con l'una o con l'altra
    // renderebbe il referto una bugia in una delle due direzioni.
    const rolledBack = results.filter((r) => r.status === 'rolled-back');
    const orphan = results.filter((r) => r.status === 'orphan');
    return {
      ok: refused.length === 0 && orphan.length === 0 && stoppedBy == null,
      at: new Date(t0).toISOString(), latencyMs: now() - t0,
      attempted: placed.length + refused.length + rolledBack.length + orphan.length,
      placed: placed.length, refused: refused.length, skipped: skipped.length,
      rolledBack: rolledBack.length, orphan: orphan.length,
      stoppedBy, reason, results,
      totals: {
        requestedUsd: +rows.reduce((s, r) => s + (Number(r.price) * Number(r.size) || 0), 0).toFixed(2),
        placedUsd: +placed.reduce((s, r) => s + (r.notionalUsd || 0), 0).toFixed(2),
        rows: rows.length,
        // I MERCATI, non le righe: con due gambe per mercato «5 righe piazzate» non dice se sono 5
        // mercati a metà o 2 mercati interi più uno rotto.
        mercati: new Set(rows.map((r) => (r.coppia ? String(r.coppia) : String(r.marketId)))).size,
        mercatiCompleti: (() => {
          const perMercato = new Map();
          for (const r of results) {
            const k = r.marketId ? String(r.marketId) : '?';
            const v = perMercato.get(k) || { tot: 0, ok: 0 };
            v.tot += 1; if (r.status === 'placed') v.ok += 1;
            perMercato.set(k, v);
          }
          let n = 0;
          for (const v of perMercato.values()) if (v.tot > 0 && v.ok === v.tot) n += 1;
          return n;
        })(),
      },
      ...extra,
    };
  };

  if (!rows.length) return report('no-rows', 'nessuna riga da eseguire');

  // ── GATE 0 — the kill switch, once, up front. Checking it per row would let a kill set mid-sequence
  //    leave half an allocation live with no record of why the rest never happened. ──
  const kill = killStatusFn(deps.killDeps || {});
  if (kill.effectivelyKilled === true || kill.readable === false) {
    for (const r of rows) results.push({ ...rowRef(r), status: 'skipped', reason: 'kill-switch attivo' });
    return report('kill', kill.readable === false
      ? 'stato del kill-switch NON leggibile — trattato come attivo: nessun ordine viene piazzato'
      : 'kill-switch ATTIVO — nessun ordine viene piazzato');
  }

  const engine = deps.engine || readEngineState();
  const caps = capsOf({ userId, engine }, deps.limitDeps || {});
  if (!caps || caps.readable !== true || !Number.isFinite(caps.maxOpenNotionalUsd)) {
    for (const r of rows) results.push({ ...rowRef(r), status: 'skipped', reason: 'limiti di rischio non leggibili' });
    return report('caps-unreadable', 'i limiti di rischio non sono leggibili — rifiuto l\'intera sequenza (limite assente ≠ illimitato)');
  }

  // The cumulative budget starts from exposure ALREADY open, not from zero: a bulk run must not be able
  // to add a full cap's worth on top of positions that are already there.
  const alreadyOpen = Number.isFinite(deps.openNotionalUsd) ? deps.openNotionalUsd : 0;
  const ceiling = caps.maxOpenNotionalUsd;
  let running = alreadyOpen;

  // ── IL RATE LIMIT, GUARDATO PRIMA E NON SUBITO ─────────────────────────────────────────────────
  // Il tetto di 20 ordini per finestra da 60s è applicato per-ordine da placeManualOrder, che rifiuta
  // il ventunesimo. Con UNA riga per mercato quel rifiuto era un mercato in meno; con DUE gambe è una
  // coppia spezzata a metà — cioè esattamente l'esposizione asimmetrica che questo file esiste per
  // impedire. Il ripristino la chiuderebbe comunque, ma cancellare una gamba appena piazzata costa un
  // giro al venue e un posto in coda per niente: meglio non inviarla.
  //
  // Quindi il conto si fa PRIMA, sulla coppia intera, con lo stesso schema del cap cumulativo.
  // `ordersInWindow` è quanto della finestra è già stato consumato da altri (iniettabile); assente
  // vale 0, che è ciò che si sa quando nessuno l'ha misurato — e il gate per-ordine resta comunque
  // l'ultima parola, quindi una stima ottimista qui non può far passare un ordine oltre il tetto.
  const rateCapTotale = Number.isFinite(caps.maxOrdersPerWindow) ? caps.maxOrdersPerWindow : null;
  // ── LA QUOTA RISERVATA AI RINNOVI (12 agosto 2026, decisione dell'operatore) ───────────────────
  //
  // La finestra del rate limit è UNA e la condividono due corsie con priorità diverse:
  //   · le APERTURE (questo file) mettono capitale nuovo al lavoro — possono aspettare il giro dopo;
  //   · i RINNOVI e le CANCELLAZIONI PROTETTIVE tengono vivo capitale GIÀ al lavoro — non possono.
  // Un ordine che muore per scadenza perché il rinnovo non ha trovato posto è capitale che torna
  // fermo, cioè il danno esatto che l'obiettivo di utilizzo esiste per evitare. Quindi le aperture
  // non possono consumare l'intera finestra: si fermano al 60% e il resto NON è attingibile.
  //
  // ⚠ SUI VOLUMI DI OGGI QUESTA QUOTA NON MORDE MAI, e va detto invece di lasciarlo credere. Misurato
  // sulle 48 ore: 141 intent in tutto, picco 18 in un minuto (aperture) e 10 (rinnovi), contro un
  // tetto di 40 ⇒ 24 posti alle aperture e 16 riservati, entrambi sopra il picco osservato. Il gate
  // del rate limit del venue ha morso UNA volta in 48 ore, ed era il vecchio tetto di 20.
  // È una rete, non una correzione: serve quando i volumi cresceranno, e costa zero finché non serve.
  //
  // ⚠ E NON È LA CAUSA PER CUI GLI ORDINI MUOIONO OGGI. Quella la dice il campo `reason` di
  // `scaduto-senza-rinnovo`: «il rinnovo era dovuto ed è stato fermato da motore-non-conforme»
  // — `mai-primo-sul-libro`, `profondita-insufficiente`. Il rimpiazzo non passava le regole del
  // motore, non il rate limit. Vedi §5 punto 116.
  const QUOTA_APERTURE = 0.60;
  const rateCap = rateCapTotale != null ? Math.floor(rateCapTotale * QUOTA_APERTURE) : null;
  const riservati = rateCapTotale != null ? rateCapTotale - rateCap : null;
  let inviati = Number.isFinite(deps.ordersInWindow) ? deps.ordersInWindow : 0;

  audit({ ts: t0, venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: 'start',
    userId, rows: rows.length,
    requestedUsd: +rows.reduce((s, r) => s + (Number(r.price) * Number(r.size) || 0), 0).toFixed(2),
    openBefore: alreadyOpen, ceiling });

  // ── LE COPPIE, NELL'ORDINE IN CUI SONO ARRIVATE ─────────────────────────────────────────────────
  // Raggruppare non riordina: la prima comparsa di una `coppia` fissa la posizione del gruppo, così una
  // sequenza rivista e confermata resta la stessa sequenza. Una riga senza `coppia` è un gruppo di una.
  const gruppi = [];
  const perChiave = new Map();
  for (let i = 0; i < rows.length; i++) {
    const chiave = rows[i] && rows[i].coppia ? `c:${rows[i].coppia}` : `r:${i}`;
    let g = perChiave.get(chiave);
    if (!g) { g = { chiave, righe: [] }; perChiave.set(chiave, g); gruppi.push(g); }
    g.righe.push({ r: rows[i], index: i });
  }

  /** Riporta ogni riga non ancora giudicata come saltata, con lo stesso motivo. */
  const saltaResto = (daGruppo, motivo) => {
    for (let k = daGruppo; k < gruppi.length; k++) {
      for (const { r, index } of gruppi[k].righe) {
        if (results.some((x) => x.index === index)) continue;
        results.push({ ...rowRef(r), index, status: 'skipped', reason: motivo });
      }
    }
  };

  for (let gi = 0; gi < gruppi.length; gi++) {
    const gruppo = gruppi[gi];
    const accoppiato = gruppo.righe.length > 1;

    // ── I NUMERI DELLA COPPIA, prima di toccare qualunque cosa ──────────────────────────────────
    let nonValida = null;
    let notionalGruppo = 0;
    for (const { r, index } of gruppo.righe) {
      const price = Number(r.price);
      const size = Number(r.size);
      const n = (Number.isFinite(price) && Number.isFinite(size)) ? +(price * size).toFixed(4) : NaN;
      if (!Number.isFinite(n) || n <= 0) { nonValida = { r, index }; break; }
      notionalGruppo += n;
    }
    if (nonValida) {
      // Una gamba con prezzo o size non validi invalida la COPPIA: piazzare l'altra vorrebbe dire
      // costruire di proposito l'esposizione asimmetrica che tutto il resto di questo file evita.
      for (const { r, index } of gruppo.righe) {
        results.push({ ...rowRef(r), index, status: 'refused', notionalUsd: null,
          reason: accoppiato
            ? `prezzo o size non validi sulla gamba ${nonValida.r.gamba || '?'} — nessuna delle due gambe viene piazzata`
            : 'prezzo o size non validi' });
      }
      continue;
    }
    notionalGruppo = +notionalGruppo.toFixed(4);

    // ── IL PRECONTROLLO DELLA COPPIA SUL TETTO PER ORDINE (12 agosto 2026) ─────────────────────────
    //
    // IL GUASTO. Le gambe si inviano in SEQUENZA e il tetto per ordine si valuta per SINGOLO ordine.
    // Su un mercato a mid estremo le due gambe costano cifre molto diverse — `Q` share uguali per lato,
    // quindi la gamba cara costa `Q x p` e l'economica `Q x (1-p)` — e quando la cara sfonda il tetto
    // succede una cosa che dipende solo dall'ORDINE DI INVIO:
    //   · se parte prima l'economica, viene piazzata e poi la cara viene rifiutata ⇒ ripristino;
    //   · se parte prima la cara, viene rifiutata e la coppia si abbandona intera ⇒ niente da ripristinare.
    // Misurato il 12 agosto: Massachusetts (mid 0,04) ha fatto il primo caso SEI VOLTE — sei invii, sei
    // cancellazioni di ripristino, `leg-rolled-back` x6 — e Vindman (mid 0,913) il secondo.
    //
    // ⚠ IL RIPRISTINO C'E' E FUNZIONA — `leg-orphan` e' ZERO su tutta la giornata — quindi questo NON e'
    // un buco di esposizione: e' spreco. Ogni giro bruciava due chiamate al venue e una posizione in
    // coda per un ordine che sarebbe stato cancellato mezzo secondo dopo, piu' una finestra breve in
    // cui una gamba sola era davvero sul libro e poteva essere riempita. Il precontrollo la chiude.
    //
    // PERCHE' SOLO IL TETTO PER ORDINE, E NON TUTTI I CANCELLI. Questo gate e' PURO e deterministico:
    // dipende dal controvalore e dai limiti, che qui sono gia' entrambi noti, e si valuta chiamando
    // `evaluateManualCapGate` — LA STESSA funzione che poi rifiutera' davvero, con LO STESSO oggetto
    // `caps`. Precontrollare con una seconda aritmetica sarebbe il reperto D1, e precontrollare con un
    // numero diverso da quello che rifiuta e' peggio che non precontrollare.
    //   Gli altri cancelli che il prompt elenca — banda, mai-primo-sul-libro, minimo premiante —
    // dipendono dal LIBRO nell'istante del piazzamento, che questo punto non ha e non deve avere:
    // leggerlo qui vorrebbe dire due letture del book a mezzo secondo di distanza che possono
    // divergere, cioe' un precontrollo che dice «passa» su un libro che non e' piu' quello. Per quelli
    // la garanzia resta il RIPRISTINO, che agisce sul fatto invece che sulla previsione — ed e' gia'
    // in servizio e gia' provato dai sei rollback di oggi. La distinzione e' deliberata: si
    // precontrolla cio' che si puo' sapere prima, si ripristina cio' che si scopre solo dopo.
    //
    // Il tetto per MERCATO e il CAPITALE non si precontrollano qui perche' non appartengono a questo
    // punto: il primo e' gia' dentro la griglia da cui la riga nasce (`allocateBudget` non produce
    // livelli oltre il tetto), il secondo e' il cap cumulativo qui sotto, che gia' guarda la coppia
    // intera.
    if (accoppiato) {
      let gambaFuori = null;
      for (const { r, index } of gruppo.righe) {
        const n = +(Number(r.price) * Number(r.size)).toFixed(4);
        const v = evaluateManualCapGate({ notionalUsd: n, caps });
        if (v.allow !== true) { gambaFuori = { r, index, n, v }; break; }
      }
      if (gambaFuori) {
        for (const { r, index } of gruppo.righe) {
          results.push({ ...rowRef(r), index, status: 'refused',
            notionalUsd: +(Number(r.price) * Number(r.size)).toFixed(4),
            gate: 'coppia-non-atomica',
            reason: `la gamba ${gambaFuori.r.gamba || gambaFuori.r.book} non passa il tetto per ordine `
              + `(${gambaFuori.v.reason}) — NESSUNA delle due gambe viene inviata: mezza coppia sarebbe `
              + 'esposizione direzionale, e su questo mercato la matura solo perche\' una delle due parte prima' });
        }
        audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate',
          outcome: 'coppia-scartata-preflight', userId, marketId: gambaFuori.r.marketId,
          atRow: gruppo.righe[0].index, gate: gambaFuori.v.gate,
          gambaFuori: gambaFuori.r.gamba || gambaFuori.r.book, notionalUsd: gambaFuori.n,
          reason: gambaFuori.v.reason });
        continue;
      }
    }

    // ── THE CUMULATIVE CEILING. Checked BEFORE attempting, so a stop is a clean stop. ──
    // Sulla COPPIA INTERA: se non ci sta tutta, non ne entra metà.
    if (running + notionalGruppo > ceiling + 1e-9) {
      for (const { r, index } of gruppo.righe) {
        results.push({ ...rowRef(r), index, status: 'skipped', notionalUsd: +(Number(r.price) * Number(r.size)).toFixed(4),
          reason: `il cap cumulativo di esposizione aperta ($${ceiling}) sarebbe superato: già impegnati $${running.toFixed(2)}, ${accoppiato ? 'questa coppia' : 'questa riga'} ne aggiungerebbe $${notionalGruppo.toFixed(2)}` });
      }
      saltaResto(gi + 1, 'sequenza fermata al raggiungimento del cap cumulativo');
      audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: 'stopped-cap',
        userId, atRow: gruppo.righe[0].index, placed: results.filter((x) => x.status === 'placed').length, running: +running.toFixed(2), ceiling });
      return report('cap-cumulativo', `fermata al mercato ${gi + 1} di ${gruppi.length}: il cap cumulativo di $${ceiling} sarebbe superato`);
    }

    // ── IL RATE LIMIT, SULLA COPPIA INTERA ──────────────────────────────────────────────────────
    if (rateCap != null && inviati + gruppo.righe.length > rateCap) {
      const spiega = `la quota di finestra riservata alle APERTURE (${rateCap} dei ${rateCapTotale} ordini`
        + ` per finestra, ${riservati} restano ai rinnovi e alle chiusure) non lascia spazio a`
        + ` ${accoppiato ? 'entrambe le gambe' : 'questa riga'}: ${inviati} già inviati in questa finestra`;
      for (const { r, index } of gruppo.righe) {
        results.push({ ...rowRef(r), index, status: 'skipped', notionalUsd: +(Number(r.price) * Number(r.size)).toFixed(4),
          reason: `${spiega} — si riprova al giro successivo, senza errore` });
      }
      saltaResto(gi + 1, 'sequenza fermata al raggiungimento della quota di apertura');
      // ── È UN RINVIO, NON UN GUASTO, E L'AUDIT LO DEVE DIRE ───────────────────────────────────────
      // `corsia: 'apertura'` è la metà del segnale che conta: un'apertura rimandata per quota è
      // ROUTINE — il capitale aspetta dieci minuti e riprova. Un RINNOVO rimandato per quota sarebbe
      // un'ANOMALIA, perché significa che la riserva non è bastata e del capitale già al lavoro sta
      // per morire. Le due cose non devono essere lo stesso conteggio.
      audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: 'rimandato-per-quota',
        userId, corsia: 'apertura', anomalia: false, atRow: gruppo.righe[0].index,
        inviati, quotaAperture: rateCap, rateCapTotale, riservatiAiRinnovi: riservati,
        reason: spiega });
      return report('quota-apertura',
        `fermata al mercato ${gi + 1} di ${gruppi.length}: ${inviati} ordini già inviati nella finestra,`
        + ` ${accoppiato ? 'una coppia ne chiede 2' : 'questa riga ne chiede 1'} e la quota per le aperture è ${rateCap}`
        + ` (${riservati} posti restano riservati ai rinnovi) — si riprende al giro successivo`);
    }

    if (dryRunOnly) {
      for (const { r, index } of gruppo.righe) {
        results.push({ ...rowRef(r), index, status: 'skipped', notionalUsd: +(Number(r.price) * Number(r.size)).toFixed(4),
          reason: 'anteprima: nulla è stato inviato' });
      }
      running += notionalGruppo;
      continue;
    }

    // ── SI PIAZZA, GAMBA PER GAMBA ──────────────────────────────────────────────────────────────
    const piazzate = [];
    let fallita = null;
    for (const { r, index } of gruppo.righe) {
      const price = Number(r.price);
      const size = Number(r.size);
      const notional = +(price * size).toFixed(4);
      let res;
      try {
        res = await place({ marketId: r.marketId, book: r.book, side: r.side === 'SELL' ? 'SELL' : 'BUY',
          price, size, userId, source: BULK_SOURCE,
          // La riga porta la dichiarazione, questo la trasporta: il prezzo si aggancia alla coda del
          // book al momento del piazzamento, non a quello del piano (che puo' essere di minuti fa).
          inCoda: r.inCoda === true,
          // ── CHI HA PREMUTO IL BOTTONE ─────────────────────────────────────────────────────────
          // Il pannello non dichiara niente e resta manuale: e' l'operatore, con un bottone invece di
          // molti, ed e' la frase che questo file scrive da sempre accanto a BULK_SOURCE. Ma quando a
          // premerlo e' uno scheduler ogni sei ore quella frase smette di essere vera, quindi agent41
          // dichiara `auto`. Senza questa riga i due mittenti sono indistinguibili nel registro, e il
          // reset di agent41 cancella gli ordini messi a mano insieme ai propri.
          origine,
          note: `allocazione in blocco, mercato ${gi + 1}/${gruppi.length}${accoppiato ? ` gamba ${r.gamba || r.book}` : ''}` },
        // ══ IL LETTORE DEI NOSTRI ORDINI SI TRASPORTA — 18 agosto 2026 ═══════════════════════════
        // La corsia di piazzamento legge gli ordini nostri sul lato per non mettersi un tick dietro a
        // se stessa, e senza questa riga li rilegge dal venue A OGNI GAMBA: una chiamata di rete per
        // riga, anche quando il chiamante quella lista ce l'ha già in mano da un istante prima.
        //
        // ⚠ `deps.resolveOwnOrders` ERA DICHIARATA E NON LA INIETTAVA NESSUNO. Il blocco che la usa
        // non entrava mai, e nessuno lo diceva: è la classe di §5.3 «dep facoltativa senza iniettore»,
        // la quinta occorrenza in questo repo. Non era un guasto — il ripiego fa la cosa giusta — ma
        // era una cucitura morta contata come viva, e il costo era una lettura sprecata per gamba.
        //
        // ⚠ SI TRASPORTA E BASTA: se il chiamante non la passa, a valle si ripiega sulla lettura di
        // prima. Nessun comportamento cambia, cambia solo quante volte si chiede al venue.
        (deps && typeof deps.resolveOwnOrders === 'function') ? { resolveOwnOrders: deps.resolveOwnOrders } : undefined);
      } catch (e) { res = { ok: false, reason: `errore: ${e.message}` }; }
      inviati += 1;   // il tentativo consuma la finestra anche se viene rifiutato

      if (res && res.ok === true) {
        const rec = { ...rowRef(r), index, status: 'placed', notionalUsd: notional,
          sent: res.sent === true, orderId: res.orderId || null,
          reason: res.sent ? 'inviato al venue' : 'costruito, firmato e validato — non inviato (dry-run)' };
        results.push(rec);
        piazzate.push({ rec, marketId: r.marketId, notional });
        running += notional;
      } else {
        results.push({ ...rowRef(r), index, status: 'refused', notionalUsd: notional,
          gate: (res && res.gate) || null, reason: (res && res.reason) || 'rifiutato' });
        fallita = { r, index, reason: (res && res.reason) || 'rifiutato' };
        // Su una coppia si smette subito: la seconda gamba non serve se la prima non c'è.
        if (accoppiato) break;
      }
    }

    // ── UNA GAMBA SOLA NON RESTA MAI SUL LIBRO ──────────────────────────────────────────────────
    if (accoppiato && fallita && piazzate.length) {
      const orfane = [];
      for (const p of piazzate) {
        let c = null;
        if (typeof deps.cancelOrder === 'function' && p.rec.orderId) {
          try { c = await deps.cancelOrder({ orderId: p.rec.orderId, marketId: p.marketId }); }
          catch (e) { c = { ok: false, reason: e.message }; }
        } else {
          c = { ok: false, reason: p.rec.orderId ? 'nessuna funzione di cancellazione iniettata' : 'ordine senza orderId: non cancellabile' };
        }
        const tolta = !!(c && (c.ok === true || c.alreadyGone === true));
        p.rec.status = tolta ? 'rolled-back' : 'orphan';
        p.rec.rollbackReason = tolta
          ? `l'altra gamba è stata rifiutata (${fallita.reason}) — questa è stata cancellata per non lasciare un lato solo sul libro`
          : `l'altra gamba è stata rifiutata (${fallita.reason}) e la cancellazione di ripristino è FALLITA (${(c && c.reason) || 'ignoto'}): questa gamba è ancora sul libro`;
        if (tolta) running -= p.notional; else orfane.push(p.rec);
        audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate',
          outcome: tolta ? 'leg-rolled-back' : 'leg-orphan',
          userId, marketId: p.marketId, orderId: p.rec.orderId, notionalUsd: p.notional, reason: p.rec.rollbackReason });
      }
      if (orfane.length) {
        // ESPOSIZIONE ASIMMETRICA VERA. Non si aggiunge altro capitale sopra: la sequenza si ferma qui
        // e il referto nomina gli ordini da guardare a mano.
        saltaResto(gi + 1, 'sequenza fermata: è rimasta una gamba orfana che non è stato possibile cancellare');
        return report('gamba-orfana',
          `${orfane.length} gamba/e è rimasta sul libro senza la sua controparte e non è stato possibile cancellarla: `
          + orfane.map((x) => `${x.book}@${x.price} ordine ${x.orderId || 'senza id'} su ${String(x.marketId).slice(0, 12)}…`).join(', ')
          + ' — nessun altro ordine viene piazzato finché questa esposizione asimmetrica non è chiusa a mano',
          { orfane });
      }
    }
  }

  const out = report(null, null);
  audit({ ts: now(), venue: 'polymarket', source: BULK_SOURCE, op: 'bulk-allocate', outcome: out.refused ? 'partial' : 'complete',
    userId, placed: out.placed, refused: out.refused, skipped: out.skipped, placedUsd: out.totals.placedUsd });
  return out;
}

function rowRef(r) {
  return { marketId: r.marketId, title: r.title || null, book: r.book, side: r.side === 'SELL' ? 'SELL' : 'BUY', price: Number(r.price), size: Number(r.size) };
}

module.exports = { runBulkAllocation, BULK_SOURCE };

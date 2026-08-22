'use strict';
// ═══ SOLA LETTURA — la misura della vista RIPARATA (difetto J), 22 agosto 2026 ═════════════════════
// Legge il censimento prodotto dalla vera `fetchRewardMarkets` di agent24 (passate 1+2+3), poi i LIBRI
// VERI in blocco, e produce: censimento per fascia, cancelli, montepremi, concorrenza in banda, quota di
// libro alla nostra size, costo del cancello delle 24 ore, confronto corti/lunghi, simulazione distanza.
// Non scrive nulla in `data/` fuori da `data/ricerca/`, non tocca ordini, non tocca configurazione.
const fs = require('fs');
const R = '/home/bot/bot';
const { scaricaLibri } = require(R + '/lib/rewards/libri-batch');
const RS = require(R + '/lib/rewardScore');
const CONC = require(R + '/lib/rewards/concentration');
const { raggioBandaCents } = require(R + '/lib/banda-premiante');
// La griglia dei tick arriva dal venue (`/sampling-markets`, campo `minimum_tick_size`): un valore
// intermedio fra due tick ATTERRA in silenzio, e va dichiarato invece di essere simulato come se no.
const TICK = (() => {
  try {
    const a = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
    const m = new Map();
    for (const x of a) if (x && x.condition_id && Number.isFinite(Number(x.minimum_tick_size))) m.set(x.condition_id, Number(x.minimum_tick_size));
    return m;
  } catch { return new Map(); }
})();

const FRAZ = 0.456;                              // MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V corrente
const CAP_MERCATO = CONC.pavimentoPremiante ? null : null;
const SORGENTE = process.argv[2];
const USCITA   = process.argv[3];

const num = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };

(async () => {
  const src = JSON.parse(fs.readFileSync(SORGENTE, 'utf8'));
  const ora = Date.now();
  const mercati = src.mercati || src;
  const ore = (m) => (Date.parse(m.endDate) - ora) / 3.6e6;

  // ── IL CENSIMENTO, PER FASCIA ────────────────────────────────────────────────────────────────
  const conD = mercati.filter((m) => m.endDate && Number.isFinite(Date.parse(m.endDate)));
  const senzaD = mercati.length - conD.length;
  const fascia = (a, b) => conD.filter((m) => { const o = ore(m); return o >= a && o < b; });
  const sotto24 = fascia(0, 24), tra2448 = fascia(24, 48);
  const corti = [...sotto24, ...tra2448];
  const lunghi = conD.filter((m) => ore(m) >= 48);

  // ── I NOSTRI CANCELLI, uno per uno, nell'ordine in cui mordono ───────────────────────────────
  // (dichiarati, NON modificati: §4.13 vincoli della selezione automatica)
  const METEO = /\b(rain|snow|temperature|weather|hurricane|storm|degrees|fahrenheit|celsius|precipitation)\b/i;
  const cancelli = (m) => {
    const o = ore(m);
    const ms = num(m.rewardsMinSize);
    const out = [];
    if (!(o >= 24)) out.push('scadenza-sotto-24h');            // §4.13, il cancello in questione
    if (!(o <= 150 * 24)) out.push('oltre-MAX_HORIZON');
    if (ms == null) out.push('minsize-illeggibile');
    else if (!(ms <= 50)) out.push('minsize-oltre-50');
    if (METEO.test(String(m.question || ''))) out.push('famiglia-meteo');
    // pavimento premiante ≤ tetto per mercato ($61,25) — §4.2
    if (ms != null && ms * 0.98 * 1.25 > 61.25) out.push('pavimento-oltre-tetto');
    return out;
  };

  // ── I LIBRI VERI, IN BLOCCO ──────────────────────────────────────────────────────────────────
  // Si leggono i libri di TUTTI i corti (sotto 48 h) e dei primi lunghi per montepremi, così il
  // confronto del punto 5 è fra grandezze misurate sulle stesse basi.
  const lunghiTop = [...lunghi].sort((a, b) => (num(b.rewardsDailyRate) || 0) - (num(a.rewardsDailyRate) || 0)).slice(0, 300);
  const daLeggere = [...corti, ...lunghiTop];
  const tokens = [];
  for (const m of daLeggere) { if (m.tokenId) tokens.push(String(m.tokenId)); if (m.tokenIdNo) tokens.push(String(m.tokenIdNo)); }
  const { libri, mancanti } = await scaricaLibri(tokens);
  const mappa = libri instanceof Map ? libri : new Map(Object.entries(libri || {}));

  const livelli = (lv, desc) => {
    const a = (lv || []).map((x) => ({ p: parseFloat(x.price), s: parseFloat(x.size) }))
      .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.s) && x.s > 0);
    if (!a.length) return null;
    a.sort((x, y) => (desc ? y.p - x.p : x.p - y.p));
    return a;
  };

  // La posa altrui che QUALIFICA, pesata col punteggio del venue, per lato; la coppia prende il minimo.
  const qLato = (lv, mid, v) => {
    let q = 0;
    for (const o of lv) { const d = Math.abs(o.p - mid) * 100; if (d > v) continue; q += RS.scoreOrder(d, v) * o.s; }
    return q;
  };

  /** Il quadro di un mercato coi libri veri. `null` = non misurabile, MAI zero. */
  function misura(m, capitale) {
    const by = mappa.get(String(m.tokenId)), bn = m.tokenIdNo ? mappa.get(String(m.tokenIdNo)) : null;
    if (!by) return { esito: 'libro-assente' };
    const bids = livelli(by.bids, true), asks = livelli(by.asks, false);
    if (!bids || !asks) return { esito: 'senza-tocco' };
    const mid = (bids[0].p + asks[0].p) / 2;
    const vFull = num(m.rewardsMaxSpread);
    const v = raggioBandaCents(vFull);
    if (!(vFull > 0) || v == null) return { esito: 'senza-banda' };
    const qb = qLato(bids, mid, v), qa = qLato(asks, mid, v);
    const compQ = Math.min(qb, qa);
    // ⚠ concorrenza ZERO su libro LETTO non è una misura di cui fidarsi: è lo `0` che l'allocatore
    //   rifiuta di credere (§5.2 p.55). Si marca, non si conta come vittoria.
    const vuoto = !(compQ > 0);
    const d = v * FRAZ;
    const share = RS.quadraticUserShare(compQ, mid, vFull, num(m.rewardsMinSize) || 0, capitale, d);
    const rate = num(m.rewardsDailyRate) || 0;
    // La QUOTA DI LIBRO: quanto della posa qualificante in banda saremmo NOI.
    const nostraQ = (() => {
      const size = RS.sizeAllaDistanza(capitale, mid, d);
      if (size == null) return null;
      if (size < (num(m.rewardsMinSize) || 0)) return { size, q: 0, sottoMinimo: true };
      return { size, q: RS.scoreOrder(d, v) * size, sottoMinimo: false };
    })();
    const quotaLibro = (nostraQ && nostraQ.q != null && (nostraQ.q + compQ) > 0)
      ? nostraQ.q / (nostraQ.q + compQ) : null;
    return {
      esito: 'ok', mid: +mid.toFixed(4), vCents: +v.toFixed(3), maxSpread: vFull,
      bandaVuota: vuoto, competitorQ: +compQ.toFixed(2),
      nostraSize: nostraQ ? +Number(nostraQ.size).toFixed(1) : null,
      sottoMinimo: nostraQ ? nostraQ.sottoMinimo : null,
      quotaLibro: quotaLibro == null ? null : +quotaLibro.toFixed(4),
      share: share == null ? null : +share.toFixed(5),
      premioGiorno: share == null ? null : +(share * rate).toFixed(4),
      tickSize: TICK.has(m.conditionId) ? TICK.get(m.conditionId) : null,
      profonditaDavantiUsd: +bids.filter((o) => Math.abs(o.p - mid) * 100 <= v).reduce((s, o) => s + o.p * o.s, 0).toFixed(2),
    };
  }

  // ── SCENARI DI CAPITALE ─────────────────────────────────────────────────────────────────────
  // $56,08 è la size per mercato usata dai referti precedenti (cap $1.300 / 10 mercati, al netto del
  // margine); $61,25 è il tetto vero per mercato di §4.2. Si misura al primo per confrontabilità.
  const CAPITALE = 56.08;

  const arr = (lista) => lista.map((m) => {
    const g = cancelli(m);
    const q = misura(m, CAPITALE);
    return {
      conditionId: m.conditionId, q: String(m.question || '').slice(0, 72),
      ore: +ore(m).toFixed(2), rate: num(m.rewardsDailyRate), minSize: num(m.rewardsMinSize),
      maxSpread: num(m.rewardsMaxSpread), scartatoDa: g, passa: g.length === 0, ...q,
    };
  });

  const rCorti = arr(corti), rLunghi = arr(lunghiTop);

  // ── LA SIMULAZIONE DELLA DISTANZA PER FASCIA (SOLO SIMULAZIONE) ──────────────────────────────
  // Si valuta lo stesso mercato a tre distanze in CENTESIMI, e si dichiara dove la griglia dei tick
  // fa atterrare il valore chiesto: un ordine a 3,5¢ su griglia 1¢ esiste, su griglia 2,5¢ no.
  const DISTANZE = [null, 3.5, 4.5];   // null = la manopola attuale, 0,456·v
  function simula(m) {
    const by = mappa.get(String(m.tokenId));
    if (!by) return null;
    const bids = livelli(by.bids, true), asks = livelli(by.asks, false);
    if (!bids || !asks) return null;
    const mid = (bids[0].p + asks[0].p) / 2;
    const vFull = num(m.rewardsMaxSpread); if (!(vFull > 0)) return null;
    const v = raggioBandaCents(vFull); if (v == null) return null;
    const compQ = Math.min(qLato(bids, mid, v), qLato(asks, mid, v));
    const rate = num(m.rewardsDailyRate) || 0;
    const out = [];
    for (const dReq of DISTANZE) {
      const d = dReq == null ? v * FRAZ : dReq;
      // ⚠ LA GRIGLIA DEI TICK. Il prezzo chiesto non è il prezzo ottenuto: si arrotonda al tick, e su
      //   griglia 0,01 una distanza di 3,5¢ non esiste — atterra a 3¢ o 4¢. Si dichiara dove atterra.
      const tick = TICK.has(m.conditionId) ? TICK.get(m.conditionId) : null;
      const tickCents = tick == null ? null : tick * 100;
      // Si arrotonda ALLONTANANDO dal mid (come il motore, che non stringe mai su richiesta di margine).
      const dReale = tickCents == null ? d : Math.ceil((d / tickCents) - 1e-9) * tickCents;
      const atterraAltrove = tickCents != null && Math.abs(dReale - d) > 1e-9;
      const dentro = dReale < v;                // a s = v il punteggio è già zero (scoreOrder)
      const share = dentro ? RS.quadraticUserShare(compQ, mid, vFull, num(m.rewardsMinSize) || 0, CAPITALE, dReale) : 0;
      const size = RS.sizeAllaDistanza(CAPITALE, mid, dReale);
      out.push({
        distanzaChiestaCents: dReq == null ? +(v * FRAZ).toFixed(3) : dReq, manopola: dReq == null,
        tickCents, distanzaRealeCents: +dReale.toFixed(3), atterraAltrove,
        dentroBanda: dentro, raggioBandaCents: +v.toFixed(3),
        size: size == null ? null : +size.toFixed(1),
        share: share == null ? null : +share.toFixed(5),
        premioGiorno: share == null ? null : +(share * rate).toFixed(4),
      });
    }
    return { conditionId: m.conditionId, q: String(m.question || '').slice(0, 60), ore: +ore(m).toFixed(2),
      rate, maxSpread: vFull, mid: +mid.toFixed(4), competitorQ: +compQ.toFixed(2), livelli: out };
  }

  const ammissibiliCorti = rCorti.filter((r) => r.passa && r.esito === 'ok');
  const sim = corti.filter((m) => ammissibiliCorti.some((r) => r.conditionId === m.conditionId)).map(simula).filter(Boolean);

  const out = {
    at: new Date(ora).toISOString(), sorgente: SORGENTE, capitalePerMercatoUsd: CAPITALE, frazioneDistanza: FRAZ,
    censimento: {
      totali: mercati.length, senzaScadenza: senzaD,
      sotto24h: sotto24.length, tra24e48h: tra2448.length, entro48h: corti.length, oltre48h: lunghi.length,
      montepremi: {
        sotto24h: +sotto24.reduce((s, m) => s + (num(m.rewardsDailyRate) || 0), 0).toFixed(2),
        tra24e48h: +tra2448.reduce((s, m) => s + (num(m.rewardsDailyRate) || 0), 0).toFixed(2),
      },
    },
    libri: { chiesti: tokens.length, mancanti: (mancanti || []).length },
    corti: rCorti, lunghiTop: rLunghi, simulazioneDistanza: sim,
  };
  fs.writeFileSync(USCITA, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.censimento, null, 1));
  console.log('libri', JSON.stringify(out.libri));
})();

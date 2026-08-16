'use strict';
/**
 * scripts/ricerca/manopola-distanza.js — SOLA LETTURA.
 *
 * Cosa si scambia girando la manopola della distanza (§5-bis p.158), con i numeri del board vivo.
 *
 * Tre grandezze, e due sono misurate:
 *   · S — aritmetica pura, `((v−s)/v)²`. Certa.
 *   · reward atteso/giorno — modellato sul board vivo. Il RAPPORTO fra posizioni è solido (quando la
 *     nostra quota è piccola, share ≈ Qu/Qcomp ∝ S); il LIVELLO no, e si ancora al consuntivo.
 *   · tasso di fill — MISURATO dalla serie densa del mid (`observed.scoringMid` dei record
 *     `auto-reprice`, cadenza ~5 s): un ordine a distanza s viene raggiunto quando il mid si muove di
 *     almeno s verso di lui. Si conta su finestre da 60 s, la stessa forma di §5.2 p.20.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const conc = require('../../lib/rewards/concentration');
const { horizonVerdict } = require('../../lib/rewards/horizon');
const { planBehindBest } = require('../../lib/maker/top-of-book');
const { raggioBandaCents, punteggio } = require('../../lib/banda-premiante');

const DATA = path.join(__dirname, '..', '..', 'data');
const OUT = path.join(DATA, 'ricerca', 'manopola-distanza.json');
const CAPITALE = 2149.88;
const COSTO_COPPIA = 0.98;
const MAX_SHARE = 0.60;
const V_MODALE = 4.5;
const DISTANZA_ATTUALE_C = 1.0;      // mediana misurata, §5-bis p.152
const FILL_GIORNO_ATTUALE = 4.6;     // episodi/giorno misurati, §5-bis p.152
const COSTO_FILL_USD = 0.05 / 4.6;   // $0,05/g di spread su 4,6 fill ⇒ costo per fill
const sp = (p) => +(1 - p).toFixed(10);

(async () => {
  // ── ① LA SERIE DENSA DEL MID: quanto si muove in 60 s, per mercato ──────────────────────────────
  const serie = new Map();   // marketRef -> [{t, mid}]
  const f = path.join(DATA, 'polymarket-maker-audit.jsonl');
  const rl = readline.createInterface({ input: fs.createReadStream(f, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.indexOf('scoringMid') === -1) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const m = r.observed && Number(r.observed.scoringMid);
    if (!Number.isFinite(m) || !r.marketRef || !Number.isFinite(r.ts)) continue;
    if (!serie.has(r.marketRef)) serie.set(r.marketRef, []);
    serie.get(r.marketRef).push({ t: r.ts, mid: m });
  }
  rl.close();

  // Escursione massima del mid in ogni finestra da 60 s, in centesimi.
  const escursioni = [];
  for (const punti of serie.values()) {
    punti.sort((a, b) => a.t - b.t);
    let i = 0;
    for (let j = 0; j < punti.length; j++) {
      while (punti[j].t - punti[i].t > 60_000) i++;
      if (j === i) continue;
      let lo = Infinity; let hi = -Infinity;
      for (let k = i; k <= j; k++) { if (punti[k].mid < lo) lo = punti[k].mid; if (punti[k].mid > hi) hi = punti[k].mid; }
      escursioni.push((hi - lo) * 100);
    }
  }
  escursioni.sort((a, b) => a - b);
  const quotaOltre = (s) => {
    if (!escursioni.length) return null;
    let lo = 0; let hi = escursioni.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (escursioni[m] < s) lo = m + 1; else hi = m; }
    return +((escursioni.length - lo) / escursioni.length).toFixed(5);
  };

  // ── ② IL BOARD VIVO, col tetto e l'orizzonte di adesso ──────────────────────────────────────────
  const board = JSON.parse(fs.readFileSync(path.join(DATA, 'liquidity-rewards.json'), 'utf8'));
  const tetto = conc.capPerMarketUsd(CAPITALE);
  const ora = Date.now();
  const utili = [];
  for (const m of board.markets || []) {
    if (!(m.rewardsMaxSpread > 0 && m.rewardsDailyRate > 0 && m.mid > 0)) continue;
    const h = horizonVerdict({ endDate: m.endDate, nowMs: ora });
    if (!h || h.state === 'resolved' || h.state === 'too-far') continue;
    if (conc.pavimentoPremiante(m.rewardsMinSize) > tetto + 1e-9) continue;
    const r = raggioBandaCents(m.rewardsMaxSpread);
    const a = planBehindBest({ bestOther: m.bestBid > 0 ? m.bestBid : null, tick: m.tickSize, scoringMid: m.mid, bandRadiusCents: r, env: {} });
    const v = planBehindBest({ bestOther: m.bestAsk > 0 ? sp(m.bestAsk) : null, tick: m.tickSize, scoringMid: sp(m.mid), bandRadiusCents: r, env: {} });
    if (a.quotabile === false || v.quotabile === false || a.ok !== true || v.ok !== true) continue;
    utili.push(m);
  }
  const N = Math.min(Math.floor(CAPITALE / tetto), conc.MAX_MERCATI);

  function rewardTotale(sCents) {
    const righe = utili.map((m) => {
      const S = punteggio(sCents, m.rewardsMaxSpread);
      if (!(S > 0)) return 0;
      const nostro = (tetto / COSTO_COPPIA) * S;
      const dep = Number(m.existing_depth_usd);
      const altri = Number.isFinite(dep) && dep > 0 ? dep / (m.mid || 0.5) : 0;
      return Math.min(altri > 0 ? nostro / (nostro + altri) : MAX_SHARE, MAX_SHARE) * m.rewardsDailyRate;
    }).sort((a, b) => b - a).slice(0, N);
    return +righe.reduce((a, b) => a + b, 0).toFixed(2);
  }

  const base = rewardTotale(DISTANZA_ATTUALE_C);
  const baseFill = quotaOltre(DISTANZA_ATTUALE_C);
  const righe = [1.0, 1.5, 2.0, 2.5].map((mult) => {
    const s = +(DISTANZA_ATTUALE_C * mult).toFixed(2);
    const S = +punteggio(s, V_MODALE).toFixed(4);
    const rw = rewardTotale(s);
    const q = quotaOltre(s);
    const fillGiorno = (baseFill && q != null) ? +(FILL_GIORNO_ATTUALE * (q / baseFill)).toFixed(2) : null;
    return {
      moltiplicatore: mult, distanzaC: s, frazioneDiV: +(s / V_MODALE).toFixed(3), S,
      rewardModellatoGiorno: rw, rewardVsOggiPct: +((rw / base - 1) * 100).toFixed(1),
      quotaFinestreOltre: q, fillAlGiornoAtteso: fillGiorno,
      fillEvitatiAlGiorno: fillGiorno != null ? +(FILL_GIORNO_ATTUALE - fillGiorno).toFixed(2) : null,
      risparmioUscitaGiorno: fillGiorno != null ? +((FILL_GIORNO_ATTUALE - fillGiorno) * COSTO_FILL_USD).toFixed(4) : null,
    };
  });

  const res = { generatoAl: new Date().toISOString(), capitale: CAPITALE, tettoPerMercato: tetto,
    mercatiUtili: utili.length, mercatiCoperti: N, vModale: V_MODALE,
    finestre60s: escursioni.length, mercatiNellaSerie: serie.size, righe };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

  console.log(`board: ${utili.length} mercati utili · il capitale ne copre ${N} · tetto $${tetto}`);
  console.log(`serie densa del mid: ${escursioni.length.toLocaleString('it')} finestre da 60 s su ${serie.size} mercati (MISURATO)\n`);
  console.log('  ×      dist    fraz.V      S     reward/g   vs oggi   fill/g    fill evitati   risparmio uscita/g');
  for (const r of righe) {
    console.log(`  ${String(r.moltiplicatore).padEnd(5)} ${String(r.distanzaC).padStart(5)}¢ ${String(r.frazioneDiV).padStart(8)} ${String(r.S).padStart(7)} `
      + `${String(r.rewardModellatoGiorno).padStart(9)} ${String(r.rewardVsOggiPct + '%').padStart(9)} `
      + `${String(r.fillAlGiornoAtteso).padStart(8)} ${String(r.fillEvitatiAlGiorno).padStart(14)} ${String('$' + r.risparmioUscitaGiorno).padStart(19)}`);
  }
  console.log(`\nscritto in ${OUT}`);
})();

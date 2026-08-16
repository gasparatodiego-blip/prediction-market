'use strict';

/**
 * ANALISI DEL COLLASSO DELLA COPERTURA — sola lettura.
 *
 * Risponde ai punti 2, 3, 4 e 6 della diagnosi: distribuzione delle variazioni, episodi di collasso,
 * soglia sulla derivata con tabella di sensibilità, e relazione fra copertura e PnL.
 *
 * ⚠ LA REGOLA CHE GOVERNA TUTTO IL FILE: una soglia si fissa DOPO aver misurato quanto oscilla
 * normalmente il numero, mai prima. Per questo la tabella di sensibilità è obbligatoria e la riga
 * «quanti falsi positivi» sta accanto a «quanti veri positivi».
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca');
const D = JSON.parse(fs.readFileSync(path.join(OUT, 'serie-copertura.json'), 'utf8'));

const q = (arr, p) => {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};
const stat = (arr) => ({
  n: arr.length,
  mediana: +q(arr, 0.5).toFixed(4), q75: +q(arr, 0.75).toFixed(4), q90: +q(arr, 0.90).toFixed(4),
  q95: +q(arr, 0.95).toFixed(4), q99: +q(arr, 0.99).toFixed(4),
  max: arr.length ? +Math.max(...arr).toFixed(4) : NaN,
});

const R = {};

// ══ 0 · LA CADENZA REALE, perché una «variazione fra campioni consecutivi» senza cadenza non è una
//        derivata. Se il campionamento è irregolare, la stessa variazione significa cose diverse.
{
  const dtA = [];
  for (let i = 1; i < D.serieA.length; i++) dtA.push((D.serieA[i].ts - D.serieA[i - 1].ts) / 1000);
  R.cadenza = {
    serieA_sec: stat(dtA),
    nota: 'cadenza IRREGOLARE: per questo le derivate sotto sono normalizzate per minuto, non per campione',
  };
}

// ══ 2 · DISTRIBUZIONE DELLE VARIAZIONI ═════════════════════════════════════════════════════════
// Si misura sia il salto grezzo fra campioni sia il salto NORMALIZZATO per minuto. Il secondo è
// l'unico confrontabile fra campioni distanti 20 s e campioni distanti 10 minuti.
function variazioni(serie, campo) {
  const ass = []; const pct = []; const perMin = []; const cali = [];
  for (let i = 1; i < serie.length; i++) {
    const a = serie[i - 1]; const b = serie[i];
    const va = Number(a[campo]); const vb = Number(b[campo]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    const dt = (b.ts - a.ts) / 60000;
    if (!(dt > 0)) continue;
    const d = vb - va;
    ass.push(Math.abs(d));
    if (va > 0) {
      const p = (d / va) * 100;
      pct.push(Math.abs(p));
      perMin.push(Math.abs(p) / dt);
      if (d < 0) cali.push({ i, ts: b.ts, da: va, a: vb, pct: p, pctPerMin: p / dt, dtMin: dt });
    }
  }
  return { ass: stat(ass), pct: stat(pct), pctPerMin: stat(perMin), cali };
}

const vA = variazioni(D.serieA, 'n');
const vMercati = variazioni(D.serieBC, 'mercati');
const vUsd = variazioni(D.serieBC, 'usd');
R.variazioni = {
  A_ordiniAperti: { assoluta: vA.ass, percentuale: vA.pct, percentualePerMinuto: vA.pctPerMin },
  B_mercatiCoperti: { assoluta: vMercati.ass, percentuale: vMercati.pct, percentualePerMinuto: vMercati.pctPerMin },
  C_nozionaleUsd: { assoluta: vUsd.ass, percentuale: vUsd.pct, percentualePerMinuto: vUsd.pctPerMin },
};

// ══ 3 · EPISODI DI COLLASSO ════════════════════════════════════════════════════════════════════
// Definizione operativa: il livello scende di oltre il 50% rispetto al massimo delle ultime FINESTRA
// ms, e ci resta. Si usa il MASSIMO recente e non il campione precedente perché un crollo può
// arrivare in due o tre campioni consecutivi e la differenza campione-a-campione lo spezzerebbe in
// pezzi ciascuno sotto soglia.
const FIN_COLL = 10 * 60e3;
function episodi(serie, campo, fracCalo = 0.5, minLivello = 5) {
  const out = [];
  let ep = null;
  for (let i = 0; i < serie.length; i++) {
    const t = serie[i].ts; const v = Number(serie[i][campo]);
    let picco = 0; let tPicco = null;
    for (let k = i - 1; k >= 0 && serie[k].ts >= t - FIN_COLL; k--) {
      if (Number(serie[k][campo]) > picco) { picco = Number(serie[k][campo]); tPicco = serie[k].ts; }
    }
    const crollo = picco >= minLivello && v <= picco * (1 - fracCalo);
    if (crollo && !ep) ep = { inizio: tPicco, tCrollo: t, prima: picco, dopo: v, minimo: v, fine: t };
    else if (ep) {
      ep.minimo = Math.min(ep.minimo, v);
      // L'episodio finisce quando si risale sopra metà del livello di partenza.
      if (v > ep.prima * 0.5) { ep.fine = t; out.push(ep); ep = null; }
      else ep.fine = t;
    }
  }
  if (ep) { ep.aperto = true; out.push(ep); }
  return out;
}
const epA = episodi(D.serieA, 'n');
R.episodi = epA.map((e) => ({
  inizioIso: new Date(e.inizio).toISOString(),
  crolloIso: new Date(e.tCrollo).toISOString(),
  fineIso: new Date(e.fine).toISOString(),
  prima: e.prima, dopo: e.dopo, minimo: e.minimo,
  caloPct: +(((e.dopo - e.prima) / e.prima) * 100).toFixed(1),
  durataVuotoMin: +((e.fine - e.tCrollo) / 60000).toFixed(1),
  aperto: e.aperto === true,
}));

// ── il PnL nella finestra dell'episodio e nei 60 minuti dopo ────────────────────────────────────
const pnlA = (t) => {
  let best = null;
  for (const p of D.seriePnl) { if (p.ts <= t) best = p; else break; }
  return best;
};
for (const e of R.episodi) {
  const t0 = Date.parse(e.crolloIso);
  const a = pnlA(t0 - 5 * 60e3); const b = pnlA(t0 + 60e3); const c = pnlA(t0 + 60 * 60e3);
  e.pnl = {
    prima5min: a ? a.pnl : null, subitoDopo: b ? b.pnl : null, dopo60min: c ? c.pnl : null,
    deltaNellaFinestra: a && b ? +(b.pnl - a.pnl).toFixed(2) : null,
    deltaNei60minDopo: b && c ? +(c.pnl - b.pnl).toFixed(2) : null,
  };
}

// ══ 4 · SOGLIA SULLA DERIVATA — tabella di sensibilità ════════════════════════════════════════
// FORMA SCELTA: **calo percentuale rispetto al massimo delle ultime 10 min**, non variazione
// campione-a-campione. Motivo misurato: la cadenza è irregolare (vedi R.cadenza), quindi la
// differenza fra due campioni consecutivi mescola «quanto è cambiato» con «quanto tempo è passato»;
// il calo dal massimo recente è invece invariante rispetto al campionamento.
//
// VERO POSITIVO = l'episodio contiene uno scatto del guardiano o una finestra di vuoto prolungato.
// FALSO POSITIVO = ogni altro allarme.
const scatti = D.seriePnl.filter((p) => p.scatto).map((p) => p.ts);
function valuta(fracCalo, minLivello) {
  const eps = episodi(D.serieA, 'n', fracCalo, minLivello);
  let vp = 0; let fp = 0;
  const dett = [];
  for (const e of eps) {
    const vicinoAScatto = scatti.some((s) => Math.abs(s - e.tCrollo) <= 15 * 60e3);
    // Vuoto prolungato: il livello resta sotto 3 ordini per più di 30 minuti.
    const vuotoLungo = e.minimo <= 2 && (e.fine - e.tCrollo) >= 30 * 60e3;
    if (vicinoAScatto || vuotoLungo) vp++; else fp++;
    dett.push({ iso: new Date(e.tCrollo).toISOString(), prima: e.prima, dopo: e.dopo,
      vero: vicinoAScatto || vuotoLungo });
  }
  return { fracCalo, minLivello, episodi: eps.length, veriPositivi: vp, falsiPositivi: fp, dett };
}
R.sensibilita = [];
for (const f of [0.30, 0.40, 0.50, 0.60, 0.70, 0.80]) R.sensibilita.push(valuta(f, 5));
R.sensibilitaLivelloMinimo = [];
for (const L of [3, 5, 8, 10, 12]) R.sensibilitaLivelloMinimo.push(valuta(0.5, L));

// ══ 6 · COPERTURA E PnL ════════════════════════════════════════════════════════════════════════
// Domanda: le perdite maturano MENTRE il book è scoperto, o prima?
// Si allineano le due serie su griglia di 5 minuti e si misura la variazione di PnL nei bucket
// «coperti» (ordini sopra la mediana) contro quelli «scoperti» (sotto il q25).
{
  const G = 5 * 60e3;
  const grid = new Map();
  for (const s of D.serieA) { const k = Math.floor(s.ts / G) * G; grid.set(k, { ...(grid.get(k) || {}), n: s.n }); }
  for (const p of D.seriePnl) { const k = Math.floor(p.ts / G) * G; grid.set(k, { ...(grid.get(k) || {}), pnl: p.pnl }); }
  const punti = [...grid.entries()].filter(([, v]) => Number.isFinite(v.n) && Number.isFinite(v.pnl))
    .map(([k, v]) => ({ ts: k, n: v.n, pnl: v.pnl })).sort((a, b) => a.ts - b.ts);
  const livelli = punti.map((p) => p.n);
  const med = q(livelli, 0.5); const q25 = q(livelli, 0.25);
  let dCop = 0; let nCop = 0; let dSco = 0; let nSco = 0;
  const dPnlPerOra = [];
  for (let i = 1; i < punti.length; i++) {
    const dt = (punti[i].ts - punti[i - 1].ts) / 3600e3;
    if (!(dt > 0) || dt > 0.5) continue;
    const d = (punti[i].pnl - punti[i - 1].pnl) / dt;
    dPnlPerOra.push({ n: punti[i - 1].n, dPnl: d });
    if (punti[i - 1].n >= med) { dCop += d; nCop++; } else if (punti[i - 1].n <= q25) { dSco += d; nSco++; }
  }
  // Correlazione di Pearson fra livello di copertura e variazione di PnL nell'intervallo successivo.
  const xs = dPnlPerOra.map((p) => p.n); const ys = dPnlPerOra.map((p) => p.dPnl);
  const mx = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const my = ys.reduce((a, b) => a + b, 0) / (ys.length || 1);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  R.copertura_pnl = {
    puntiAllineati: punti.length,
    medianaOrdini: med, q25Ordini: q25,
    variazionePnlPerOra_quandoCoperto: nCop ? +(dCop / nCop).toFixed(3) : null,
    variazionePnlPerOra_quandoScoperto: nSco ? +(dSco / nSco).toFixed(3) : null,
    campioniCoperto: nCop, campioniScoperto: nSco,
    correlazionePearson: dx > 0 && dy > 0 ? +(num / Math.sqrt(dx * dy)).toFixed(4) : null,
  };
}

// ══ IL SALTO DI PnL CHE HA FATTO SCATTARE IL GUARDIANO ════════════════════════════════════════
// La domanda vera del punto 5 non è solo «chi ha cancellato», ma «su quale misura si è deciso».
{
  const salti = [];
  for (let i = 1; i < D.seriePnl.length; i++) {
    const a = D.seriePnl[i - 1]; const b = D.seriePnl[i];
    const dt = (b.ts - a.ts) / 1000;
    if (!(dt > 0) || dt > 120) continue;
    salti.push({ ts: b.ts, d: b.pnl - a.pnl, dtSec: dt, scatto: b.scatto });
  }
  const ampiezze = salti.map((s) => Math.abs(s.d));
  R.saltiPnl = {
    cadenzaTipicaSec: +q(salti.map((s) => s.dtSec), 0.5).toFixed(1),
    distribuzioneAmpiezzaUsd: stat(ampiezze),
    oltre10usd: salti.filter((s) => Math.abs(s.d) > 10).length,
    oltre20usd: salti.filter((s) => Math.abs(s.d) > 20).length,
    oltre30usd: salti.filter((s) => Math.abs(s.d) > 30).length,
    iPiuGrandi: salti.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12)
      .map((s) => ({ iso: new Date(s.ts).toISOString(), deltaUsd: +s.d.toFixed(2), dtSec: s.dtSec, scatto: !!s.scatto })),
  };
}

fs.writeFileSync(path.join(OUT, 'analisi-collasso.json'), JSON.stringify(R, null, 1));
console.log(JSON.stringify({
  cadenza: R.cadenza, variazioni: R.variazioni, episodi: R.episodi,
  copertura_pnl: R.copertura_pnl, saltiPnl: R.saltiPnl,
}, null, 1));

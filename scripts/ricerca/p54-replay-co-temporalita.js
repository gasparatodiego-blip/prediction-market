'use strict';
// SOLA LETTURA — §5.2 p.54: il guardiano vecchio contro il nuovo, sulle letture VERE.
// Funzioni di produzione, nessuna riscrittura: valutaCapitale · calcolaPnl · decidiScatto ·
// confermaScatto · aggiornaRiferimento · sogliaAssoluta.
const fs = require('fs'); const path = require('path'); const glob = require('fs');
const R = path.resolve(__dirname, '..', '..');
const G = require(path.join(R, 'lib/maker/guardian-perdite'));
const RIF = require(path.join(R, 'lib/maker/guardian-riferimento'));

const dir = path.join(R, 'data/osservatore');
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => /^campioni-.*\.jsonl$/.test(x)).sort()) {
  for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.saldoFonte !== 'diretta' || r.posizioniFonte !== 'diretta') continue;
    rows.push(r);
  }
}
rows.sort((a, b) => a.at - b.at);

// ⚠ APPROSSIMAZIONE DICHIARATA. L'osservatore registra le posizioni per MERCATO (conditionId,
// valoreUsd), non per token con la size. Si costruisce una pseudo-posizione per mercato — size 1 al
// prezzo = valore — cosi' la funzione VERA vede: mercato che compare/sparisce ⇒ Δsize (un fill o una
// chiusura); mercato presente in entrambe con valore diverso ⇒ Δprezzo. E' la stessa semantica del
// criterio; cio' che sfugge e' un cambio di size DENTRO un mercato che resta aperto, che sottostima i
// rifiuti. Il numero che ne esce e' quindi un LIMITE INFERIORE degli artefatti tolti.
const posDi = (r) => (r.posizioniPerMercato || []).map((p) => ({
  tokenId: String(p.conditionId), size: 1, curPrice: Number(p.valoreUsd),
}));

const SOGLIA_PCT = 5; const PAVIMENTO = 30;
function corri({ conRiconciliazione }) {
  let prec = null; let statoConf = null; let statoRif = null;
  let latch = null; const scatti = []; const preallarmi = [];
  let rifiutate = 0; let misurate = 0; let maxDiFila = 0; let diFila = 0;
  const totali = [];
  for (const r of rows) {
    const posizioni = posDi(r);
    const cap = G.valutaCapitale({
      saldoUsd: r.saldoUsd, posizioni, posizioniLeggibili: true,
      riconciliazione: conRiconciliazione ? { at: r.at, precedente: prec } : 'non-richiesta',
    });
    prec = { at: r.at, saldoUsd: r.saldoUsd, posizioni };
    if (!cap.leggibile) { rifiutate += 1; diFila += 1; maxDiFila = Math.max(maxDiFila, diFila); continue; }
    misurate += 1; diFila = 0;
    totali.push({ at: r.atIso, tot: cap.totaleUsd });
    // il cricchetto: sale solo su conferma (D-D), e non si muove su lettura non misurabile
    const up = RIF.aggiornaRiferimento({ stato: statoRif, capitale: cap, now: r.at,
      osservazione: { saldoLetturaAt: r.at, posizioniEtaMs: r.posizioniEtaMs } });
    if (up.stato) statoRif = up.stato;
    const rifUsd = up.riferimentoUsd;
    if (!Number.isFinite(Number(rifUsd))) continue;
    if (latch) continue;                                  // dopo lo scatto il guardiano non misura piu'
    const pnl = G.calcolaPnl({ baselineUsd: rifUsd, totaleUsd: cap.totaleUsd });
    const abs = RIF.sogliaAssoluta({ riferimentoUsd: rifUsd, pavimentoUsd: PAVIMENTO }).sogliaUsd;
    const dec = G.decidiScatto({ pnl, sogliaPct: SOGLIA_PCT, sogliaAbs: abs });
    const conf = G.confermaScatto({ stato: statoConf, decisione: dec, pnl, now: r.at,
      osservazione: { saldoLetturaAt: r.at } });
    statoConf = conf.stato;
    if (conf.preAllarme) preallarmi.push({ at: r.atIso, tot: cap.totaleUsd, pnl: pnl.pnlUsd });
    if (conf.scatta) { scatti.push({ at: r.atIso, tot: cap.totaleUsd, pnl: pnl.pnlUsd, rif: rifUsd }); latch = r.atIso; }
  }
  return { scatti, preallarmi, rifiutate, misurate, maxDiFila, riferimentoFinale: statoRif ? statoRif.riferimentoUsd : null, totali };
}

const vecchio = corri({ conRiconciliazione: false });
const nuovo = corri({ conRiconciliazione: true });
const giorni = (rows[rows.length - 1].at - rows[0].at) / 86400000;

const out = [];
const P = (s) => { out.push(s); console.log(s); };
P(`SERIE: ${rows.length} letture · ${rows[0].atIso} → ${rows[rows.length - 1].atIso} · ${giorni.toFixed(2)} giorni`);
P('');
P('                              VECCHIO      NUOVO');
P(`  letture misurate            ${String(vecchio.misurate).padStart(7)}   ${String(nuovo.misurate).padStart(8)}`);
P(`  letture RIFIUTATE           ${String(vecchio.rifiutate).padStart(7)}   ${String(nuovo.rifiutate).padStart(8)}`);
P(`  disponibilita'              ${(100 * vecchio.misurate / rows.length).toFixed(2).padStart(6)}%   ${(100 * nuovo.misurate / rows.length).toFixed(2).padStart(7)}%`);
P(`  rifiuti consecutivi (max)   ${String(vecchio.maxDiFila).padStart(7)}   ${String(nuovo.maxDiFila).padStart(8)}`);
P(`  PRE-ALLARMI                 ${String(vecchio.preallarmi.length).padStart(7)}   ${String(nuovo.preallarmi.length).padStart(8)}`);
P(`  SCATTI                      ${String(vecchio.scatti.length).padStart(7)}   ${String(nuovo.scatti.length).padStart(8)}`);
P(`  riferimento finale          ${vecchio.riferimentoFinale ? ('$' + vecchio.riferimentoFinale.toFixed(2)).padStart(7) : '    n/d'}   ${nuovo.riferimentoFinale ? ('$' + nuovo.riferimentoFinale.toFixed(2)).padStart(8) : '     n/d'}`);
for (const [nome, r] of [['VECCHIO', vecchio], ['NUOVO', nuovo]]) {
  if (r.scatti.length) { P(`\n  scatti ${nome}:`); r.scatti.forEach((s) => P(`     ${s.at}  totale $${s.tot.toFixed(2)}  PnL $${s.pnl.toFixed(2)}  rif $${s.rif.toFixed(2)}`)); }
  else P(`\n  scatti ${nome}: NESSUNO`);
  if (r.preallarmi.length) { P(`  pre-allarmi ${nome}:`); r.preallarmi.forEach((s) => P(`     ${s.at}  totale $${s.tot.toFixed(2)}  PnL $${s.pnl.toFixed(2)}`)); }
}
// artefatto residuo: scarto dalla mediana locale sui totali MISURATI
function artefatti(tot) {
  const v = tot.map((x) => x.tot); const W = 11; const dev = [];
  for (let i = 0; i < v.length; i++) {
    const f = v.slice(Math.max(0, i - 5), i + 6).slice().sort((a, b) => a - b);
    dev.push({ at: tot[i].at, d: v[i] - f[Math.floor(f.length / 2)] });
  }
  return dev;
}
for (const [nome, r] of [['VECCHIO', vecchio], ['NUOVO', nuovo]]) {
  const d = artefatti(r.totali).map((x) => -x.d).filter((x) => x > 0).sort((a, b) => b - a);
  P(`\n  artefatto residuo ${nome} (scarto sotto la mediana locale): max $${(d[0] || 0).toFixed(2)}  ·  ≥$10: ${d.filter((x) => x >= 10).length}  ·  ≥$30: ${d.filter((x) => x >= 30).length}`);
}
// escursione giornaliera vera, sui soli totali misurati dal NUOVO
const perGiorno = {};
for (const t of nuovo.totali) { (perGiorno[t.at.slice(0, 10)] ||= []).push(t.tot); }
P('\n  ESCURSIONE GIORNALIERA sui totali che il guardiano NUOVO misura:');
const esc = [];
for (const g of Object.keys(perGiorno).sort()) {
  const v = perGiorno[g]; const e = Math.max(...v) - Math.min(...v); esc.push(e);
  P(`     ${g}  n=${String(v.length).padStart(4)}  min $${Math.min(...v).toFixed(2)}  max $${Math.max(...v).toFixed(2)}  escursione $${e.toFixed(2)}`);
}
P(`     ⇒ minima $${Math.min(...esc).toFixed(2)} · massima $${Math.max(...esc).toFixed(2)}`);
fs.writeFileSync(path.join(R, 'data/ricerca/p54-replay.json'), JSON.stringify({
  generatoAl: new Date().toISOString(), letture: rows.length, giorni,
  vecchio: { ...vecchio, totali: undefined }, nuovo: { ...nuovo, totali: undefined },
  escursioneMin: Math.min(...esc), escursioneMax: Math.max(...esc),
}, null, 1));
fs.writeFileSync(path.join(R, 'data/ricerca/p54-replay.md'), out.join('\n') + '\n');

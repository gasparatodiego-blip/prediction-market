'use strict';
// scripts/ricerca/vista-board-simulazione.js — SOLA LETTURA.
// La simulazione a secco dell'allargamento del board: cosa cambia nella SELEZIONE fra un tetto di
// scansione di 150 e uno di 300, con le funzioni VERE di agent24 e di lib/maker/selezione-mercati.
// Non scrive niente fuori da data/ricerca/, non tocca ordini, processi o configurazione.
const fs = require('fs'); const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(RADICE, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const A24 = require(path.join(RADICE, 'agents/agent24-liquidity-rewards'));
const { scaricaLibri } = require(path.join(RADICE, 'lib/rewards/libri-batch'));
const SEL = require(path.join(RADICE, 'lib/maker/selezione-mercati'));
const { readVenuePositions } = require(path.join(RADICE, 'lib/safety/venue-positions-snapshot'));
const { leggiOrdiniVivi } = (() => { try { return require(path.join(RADICE, 'lib/safety/venue-orders-snapshot')); } catch { return {}; } })();

const U = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/ricerca/universo-premiante.json'), 'utf8'));
const ORA = Date.now();

// ── la popolazione: l'universo censito, nella forma di riga di board che agent24 produce ──────────
const popolazione = U.ammissibili.filter((m) => m.id && m.tokenIds && m.tokenIds.length >= 2).map((m) => ({
  conditionId: m.id, question: m.q, rewardsDailyRate: m.rate, rewardsMinSize: m.minSize,
  rewardsMaxSpread: m.maxSpread, tokenId: m.tokenIds[0], tokenIdNo: m.tokenIds[1],
  endDate: new Date(ORA + (m.ore || 48) * 3_600_000).toISOString(), oreDichiarate: m.ore, volume: m.volume,
}));
// ⚠ L'ordinamento della popolazione e' quello di agent24 PRIMA del taglio: per montepremi decrescente.
popolazione.sort((a, b) => (Number(b.rewardsDailyRate) || 0) - (Number(a.rewardsDailyRate) || 0));

(async () => {
  const out = { lettoAl: new Date(ORA).toISOString(), popolazione: popolazione.length };

  // ── i libri, UNA volta sola per tutti i token che serviranno ──────────────────────────────────
  const scelte = {};
  for (const tetto of [150, 300]) scelte[tetto] = A24.sceltiPerLaScansione(popolazione, { tetto });
  const token = new Set();
  for (const tetto of [150, 300]) for (const m of scelte[tetto]) { token.add(m.tokenId); token.add(m.tokenIdNo); }
  const t0 = Date.now();
  const LIBRI = await scaricaLibri([...token]);
  out.libri = { chiesti: LIBRI.voluti, ottenuti: LIBRI.libri.size, mancanti: LIBRI.mancanti.size,
    secondi: +((Date.now() - t0) / 1000).toFixed(1), lotti: LIBRI.lotti };

  /** Una riga di board completa di `levels`, come la produrrebbe agent24. Libro assente ⇒ ESCLUSA. */
  function rigaConLevels(m) {
    const fallbackMid = 0.5;
    const b = A24.analizzaLibro(LIBRI.libri.get(String(m.tokenId)) || null, m.rewardsMaxSpread, m.rewardsMinSize, fallbackMid);
    const bn = A24.analizzaLibro(LIBRI.libri.get(String(m.tokenIdNo)) || null, m.rewardsMaxSpread, m.rewardsMinSize, 1 - fallbackMid);
    if (b.assente || bn.assente) return null;   // la stessa regola del percorso di produzione
    const competitorQ = { Qmin: b.Qmin, Qbids: b.Qbids, Qasks: b.Qasks, mid: b.mid };
    const levels = A24.computeLevels(m.rewardsDailyRate, competitorQ, m.rewardsMaxSpread, m.rewardsMinSize);
    return { ...m, levels, mid: b.mid, bestBid: b.bestBid, bestAsk: b.bestAsk,
      concorrenzaQmin: b.Qmin, profonditaUsd: b.existingDepthUsd, emptyBook: !!b.emptyBook,
      rateOrdinamento: m.rewardsDailyRate, category: 'other', scadenzaAmmissibile: true };
  }

  const posizioni = (() => {
    const p = readVenuePositions();
    return { leggibile: !!(p && p.readable), conditionIds: (p && p.positions || []).map((x) => x.conditionId).filter(Boolean) };
  })();
  const statoReale = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/selezione-mercati.json'), 'utf8'));
  const conOrdiniVivi = (() => {
    try { const o = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/venue-orders.json'), 'utf8')); return Object.keys(o.mercati || {}); }
    catch { return []; }
  })();
  out.stato = { selezionati: Object.keys(statoReale.selezionati || {}).length, conOrdiniVivi: conOrdiniVivi.length,
    posizioni: posizioni.conditionIds.length };

  const risultati = {};
  for (const tetto of [150, 300]) {
    const righe = scelte[tetto].map(rigaConLevels).filter(Boolean);
    const esclusiSenzaLibro = scelte[tetto].length - righe.length;
    const d = SEL.decidiSelezione({
      board: righe, stato: statoReale, posizioni, ora: ORA, max: 5,
      conOrdiniVivi, nettoPerMercato: null,
    });
    // il premio atteso del piano scelto: somma dei $/giorno lordi stimati al livello del pavimento
    const premioDi = (id) => {
      const r = righe.find((x) => String(x.conditionId).toLowerCase() === String(id).toLowerCase());
      if (!r || !r.levels) return null;
      const liv = Object.keys(r.levels).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const k = liv.find((x) => x >= 61) ?? liv[0];
      const L = r.levels[String(k)] || r.levels[k];
      return L ? (Number(L.grossRewardDay) || 0) : null;
    };
    const scelti = [...(d.tenuti || []), ...(d.entranti || [])].map((x) => x.id || x.conditionId).filter(Boolean);
    risultati[tetto] = {
      valutati: d.valutati, ammissibili: d.ammissibili, esclusiSenzaLibro,
      ok: d.ok, motivo: d.motivo,
      tenuti: (d.tenuti || []).map((x) => x.id), entranti: (d.entranti || []).map((x) => x.id),
      uscenti: (d.uscenti || []).map((x) => x.id), spodestati: (d.spodestati || []).map((x) => x.id || x),
      liberati: (d.liberati || []).map((x) => x.id || x),
      postiNonAssegnati: d.postiNonAssegnati || [],
      premioAttesoUsdG: +scelti.reduce((a, id) => a + (premioDi(id) || 0), 0).toFixed(4),
      scelti,
    };
    // i 20 migliori per premio atteso fra gli AMMISSIBILI
    const amm = righe.map((r) => ({ id: r.conditionId, q: String(r.question).slice(0, 58),
      premio: premioDi(r.conditionId), minSize: r.rewardsMinSize, ore: +Number(r.oreDichiarate).toFixed(1),
      concorrenza: Math.round(r.concorrenzaQmin || 0), montepremi: r.rewardsDailyRate }))
      .filter((x) => Number.isFinite(x.premio));
    amm.sort((a, b) => b.premio - a.premio);
    risultati[tetto].top20 = amm.slice(0, 20);
    risultati[tetto].righeConLevels = righe.length;
  }
  out.risultati = risultati;
  fs.writeFileSync(path.join(RADICE, 'data/ricerca/vista-board-simulazione.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ libri: out.libri, stato: out.stato,
    a150: { ...risultati[150], top20: undefined }, a300: { ...risultati[300], top20: undefined } }, null, 1));
  console.log('\nTOP 20 con tetto 300 (premio $/g · minSize · ore · concorrenza Q):');
  for (const x of risultati[300].top20) console.log(`  ${x.premio.toFixed(3).padStart(8)}  ms${String(x.minSize).padStart(4)}  ${String(x.ore).padStart(7)}h  Q=${String(x.concorrenza).padStart(7)}  ${x.q}`);
})();

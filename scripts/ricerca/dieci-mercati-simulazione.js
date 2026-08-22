'use strict';
// scripts/ricerca/dieci-mercati-simulazione.js — SOLA LETTURA.
// SIMULAZIONE A SECCO del passaggio a 10 mercati e size al tetto pieno, 22 agosto 2026.
// Chiama le funzioni VERE — `SELM.decidiSelezione`, il RUNNER del piano di agent41, `rewardScore` —
// con gli stessi ingressi di agent41. Non scrive nessuno stato, non tocca nessun ordine.
// ⚠ SCADE COL BOARD (lezione D-A, §5-bis p.200): l'istante e' stampato in cima.
const { execFile } = require('child_process');
const fs = require('fs'); const path = require('path');
const R = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(R, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const SELM = require(path.join(R, 'lib/maker/selezione-mercati'));
const { readVenuePositions } = require(path.join(R, 'lib/safety/venue-positions-snapshot'));
const CONC = require(path.join(R, 'lib/rewards/concentration'));
const RS   = require(path.join(R, 'lib/rewardScore'));
const HOR  = require(path.join(R, 'lib/rewards/horizon'));
const fin = (x) => Number.isFinite(x);
const PERCORSO_ALLOCATOR = path.join(R, 'lib/rewards/allocator');
const RUNNER = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);process.stdout.write(JSON.stringify(require('
  + JSON.stringify(PERCORSO_ALLOCATOR) + ').planFromCollection(o)))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';

const board = JSON.parse(fs.readFileSync(path.join(R, 'data/liquidity-rewards.json'), 'utf8')).markets;
const stato = require(path.join(R, 'lib/maker/selezione-stato')).leggiStato();
const ATTUALI = new Set(Object.keys((stato.stato && stato.stato.selezionati) || {}).map(x => x.toLowerCase()));
const nome = new Map(board.map(m => [String(m.conditionId).toLowerCase(), (m.groupItemTitle ? m.groupItemTitle + ' — ' : '') + m.question]));
const riga = new Map(board.map(m => [String(m.conditionId).toLowerCase(), m]));

function posSel() {
  const p = readVenuePositions();
  if (!p || p.readable !== true) return { leggibile: false, motivo: (p && p.reason) || 'snapshot non leggibile', conditionIds: [] };
  const ids = [];
  for (const x of (p.positions || [])) { const c = typeof x.conditionId === 'string' ? x.conditionId.trim().toLowerCase() : '';
    const sz = Number(x.size); if (c && Number.isFinite(sz) && sz > 0 && !ids.includes(c)) ids.push(c); }
  return { leggibile: true, motivo: null, conditionIds: ids };
}

function piano(capitale, ammissibili, ora) {
  return new Promise((ris, rif) => {
    const f = execFile('node', ['-e', RUNNER], { timeout: 180000, maxBuffer: 64 * 1024 * 1024 },
      (err, out) => { if (err) return rif(new Error(err.killed ? 'timeout' : err.message));
        try { ris(JSON.parse(out)); } catch (e) { rif(new Error('JSON non valido: ' + e.message)); } });
    f.on('error', rif);
    f.stdin.end(JSON.stringify({ capital: capitale, maxPerMarketUsd: CONC.capPerMarketUsd(capitale),
      from: new Date(ora - 24 * 3600e3).toISOString(), to: new Date(ora).toISOString(),
      horizonFilter: true, onlyMarketIds: ammissibili }));
  });
}

// la nostra quota in banda, con la formula del venue, alla distanza REALE (2,5c su banda 4,5c)
function quota(m, capitale) {
  const Q = RS.recoverCompetitorQ(m.levels, m.mid, m.rewardsMaxSpread, m.rewardsMinSize);
  if (Q == null) return { Q: null, share: null, usd: null };
  const s = RS.quadraticUserShare(Q, m.mid, m.rewardsMaxSpread, m.rewardsMinSize, capitale, 2.5);
  return { Q, share: s, usd: s == null ? null : s * Number(m.rewardsDailyRate) };
}

(async () => {
  const ora = Date.now();
  console.log('════ SIMULAZIONE A SECCO — istante ' + new Date(ora).toISOString() + ' ════');
  console.log('board generato:', JSON.parse(fs.readFileSync(path.join(R, 'data/liquidity-rewards.json'), 'utf8')).meta.generatedAt);
  const orizzonteMassimoOre = Number(HOR.maxHorizonDays()) * 24;
  const ammissibili = board.filter((r) => SELM.valutaAmmissibilita(r, { ora, orizzonteMassimoOre }).ammissibile)
    .map(r => String(r.conditionId || '').trim().toLowerCase()).filter(Boolean);
  console.log('ammissibili:', ammissibili.length, 'su', board.length, 'valutati');

  const { leggiSaldoUsd } = require(path.join(R, 'lib/maker/saldo-cache'));
  const s = await leggiSaldoUsd();
  const saldo = s && s.affidabile === true ? s.usd : null;
  if (!fin(saldo)) { console.log('saldo non leggibile — mi fermo'); process.exit(1); }
  console.log('saldo', saldo.toFixed(2));

  const CASI = [{ nome: 'OGGI   N=5  cap $650', cap: 650, max: 5 },
                { nome: 'PIENO  N=10 cap $1300', cap: 1300, max: 10 }];
  const esiti = [];
  for (const c of CASI) {
    const capitale = Math.min(saldo, c.cap);
    const tetto = CONC.capPerMarketUsd(capitale);
    const p = await piano(capitale, ammissibili, ora);
    const netti = {};
    for (const cd of (p.candidates || [])) {
      const id = String(cd.marketId || '').trim().toLowerCase();
      const v = fin(cd.bestObiettivoPerDay) ? cd.bestObiettivoPerDay : (fin(cd.bestNetPerDay) ? cd.bestNetPerDay : null);
      if (id && v !== null) netti[id] = v;
    }
    const d = SELM.decidiSelezione({
      board, stato: stato.stato, posizioni: posSel(), ora, escludi: [],
      orizzonteMassimoOre, nettoPerMercato: netti, conOrdiniVivi: { leggibile: false },
      max: c.max, codaLungaGiorni: HOR.LONG_TAIL_DAYS, bookVivi: { leggibile: false },
      codaLungaFrazione: HOR.LONG_TAIL_CAP_FRAC, tettoPerMercatoUsd: CONC.MARKET_CAP_FIXED_USD,
      pavimentoPremiante: CONC.pavimentoPremiante,
    });
    esiti.push({ c, capitale, tetto, p, netti, d });
  }

  for (const e of esiti) {
    const p = e.p; const d = e.d;
    console.log('\n══════ ' + e.c.nome + ' ══════');
    console.log('capitale al knapsack: $' + e.capitale.toFixed(2) + '  (min(saldo, cap))  · tetto per mercato $' + e.tetto);
    console.log('unitUsd della griglia: $' + p.unit + ' · righe di piano: ' + (p.rows || []).length + ' · capitale allocato $' + Number((p.totals && p.totals.capital) || 0).toFixed(2));
    for (const r of (p.rows || [])) console.log('  RIGA DI PIANO: ' + String(r.marketId).slice(0,10)
      + ' cap $' + Number(r.capital).toFixed(2) + ' · size/lato ' + Number(r.sizePerSideShares).toFixed(1) + ' share'
      + ' · $' + Number(r.sizePerSideUsd).toFixed(2) + '/lato · pairCost ' + r.pairCostUsd
      + ' · minSize ' + r.minSizeShares + ' · capitalToQualify $' + r.capitalToQualifyUsd
      + ' · gross $' + Number(r.grossPerDay).toFixed(4) + '/g · net $' + (r.netPerDay==null?'—':Number(r.netPerDay).toFixed(4))
      + ' · fills ' + r.fills + ' · ' + String(r.name||'').slice(0,30));
    console.log('  totals:', JSON.stringify(p.totals).slice(0,320));
    console.log('classificabili (netto non nullo):', Object.keys(e.netti).length, 'su', (p.candidates || []).length, 'candidati');
        if (!d.ok) console.log('  ⚠ decidiSelezione NON ok — motivo:', d.motivo);
    if (esiti.indexOf(e) === 0) console.log('  [diagnostica] chiavi piano:', Object.keys(p).join(','), '| chiavi riga0:', (p.rows && p.rows[0]) ? Object.keys(p.rows[0]).join(',') : 'nessuna riga', '| chiavi d:', Object.keys(d).join(','));
    const attivi = [...(d.tenuti || []).map(x => String(x.id || x)), ...(d.entranti || []).map(x => String(x.id || x))];
    console.log('decidiSelezione ok=' + d.ok + ' · tenuti ' + (d.tenuti || []).length + ' · entranti ' + (d.entranti || []).length
      + ' · uscenti ' + (d.uscenti || []).length + ' ⇒ slot ' + attivi.length + '/' + e.c.max
      + ' · slotLiberi ' + d.slotLiberi + ' · postiNonAssegnati ' + JSON.stringify(d.postiNonAssegnati || null)
      + ' · ammissibili ' + d.ammissibili + ' su ' + d.valutati);
    console.log('  SCARTI: codaLunga=' + ((d.scartatiPerCodaLunga||[]).length)
      + ' codaLungaSottoPavimento=' + ((d.scartatiPerCodaLungaSottoPavimento||[]).length)
      + ' composizione=' + ((d.scartatiPerComposizione||[]).length));
    for (const k of ['scartatiPerCodaLunga','scartatiPerCodaLungaSottoPavimento','scartatiPerComposizione']) {
      const a = d[k] || []; if (a.length) console.log('    ' + k + ' [' + a.length + '] es.: ' + JSON.stringify(a[0]).slice(0,240));
    }
    if (d.slotVuotiPerScarsita) console.log('  slotVuotiPerScarsita:', JSON.stringify(d.slotVuotiPerScarsita));
    const righeP = new Map((p.rows || []).map(r => [String(r.marketId).toLowerCase(), r]));
    let totNoz = 0, totLordo = 0, totNetto = 0;
    console.log('\n  #  mercato      minSize   ore  Q_banda   quota%  cap$   size/lato  nozion.$  netto$/g   stato');
    attivi.forEach((a, i) => {
      const id = String(a.id || a).toLowerCase();
      const m = riga.get(id); const rp = righeP.get(id);
      const ore = m ? (Date.parse(m.endDate) - ora) / 3600e3 : null;
      const cap = rp && fin(rp.capital) ? rp.capital : null;
      const size = rp && fin(rp.sizePerSideShares) ? rp.sizePerSideShares : null;
      const q = m ? quota(m, cap != null ? cap : e.tetto) : { Q: null, share: null };
      const netto = e.netti[id];
      if (fin(cap)) totNoz += cap;
      if (fin(netto)) totNetto += netto;
      if (q.usd != null) totLordo += q.usd;
      console.log('  ' + String(i + 1).padStart(2) + '  ' + id.slice(0, 10)
        + '  ' + String(m ? m.rewardsMinSize : '?').padStart(6)
        + '  ' + (ore == null ? '  ?' : ore.toFixed(0).padStart(4))
        + '  ' + (q.Q == null ? '     ?' : q.Q.toFixed(0).padStart(7))
        + '  ' + (q.share == null ? '     ?' : (100 * q.share).toFixed(2).padStart(6))
        + '  ' + (cap == null ? '    ?' : cap.toFixed(2).padStart(6))
        + '  ' + (size == null ? '      ?' : size.toFixed(1).padStart(8))
        + '  ' + (cap == null ? '     ?' : cap.toFixed(2).padStart(8))
        + '  ' + (fin(netto) ? netto.toFixed(4).padStart(8) : '       ?')
        + '  ' + (ATTUALI.has(id) ? 'RESTA' : 'nuovo')
        + '  ' + (nome.get(id) || '').slice(0, 34));
    });
    console.log('  TOTALI: nozionale a riposo $' + totNoz.toFixed(2)
      + ' · lordo modellato $' + totLordo.toFixed(4) + '/g'
      + ' · netto (obiettivo) $' + totNetto.toFixed(4) + '/g');
    console.log('  esposizione massima raggiungibile a N=' + e.c.max + ': $'
      + CONC.esposizioneMassimaRaggiungibileUsd(e.c.max) + ' contro cap $' + e.c.cap
      + ' ⇒ margine $' + (e.c.cap - CONC.esposizioneMassimaRaggiungibileUsd(e.c.max)).toFixed(2));
    const oltre50 = attivi.map(a => String(a.id || a).toLowerCase())
      .filter(id => { const m = riga.get(id); if (!m) return false; const rp = righeP.get(id);
        const cap = rp && fin(rp.capital) ? rp.capital : e.tetto; const q = quota(m, cap);
        return q.share != null && q.share > 0.5; });
    console.log('  oltre il 50% del libro in banda: ' + oltre50.length + (oltre50.length ? ' → ' + oltre50.map(x => x.slice(0, 10)).join(', ') : ''));
  }

  // chi dei 5 attuali resta
  const dEnd = esiti[1].d;
  const dopo = new Set([...(dEnd.tenuti || []), ...(dEnd.entranti || [])].map(a => String(a.id || a).toLowerCase()));
  console.log('\n══════ I 5 ATTUALI ══════');
  for (const id of ATTUALI) console.log('  ' + id.slice(0, 10) + '  ' + (dopo.has(id) ? 'RESTA' : '🔴 ESCE') + '  ' + (nome.get(id) || '').slice(0, 50));
  fs.writeFileSync(path.join(R, 'data/ricerca/dieci-mercati-simulazione.json'),
    JSON.stringify({ generatoAl: new Date(ora).toISOString(), esiti: esiti.map(e => ({
      nome: e.c.nome, cap: e.c.cap, max: e.c.max, capitale: e.capitale, tetto: e.tetto,
      unitUsd: e.p.unitUsd, righePiano: (e.p.rows || []).length, totalCapital: e.p.totalCapital,
      attivi: [...(e.d.tenuti || []), ...(e.d.entranti || [])].map(a => String(a.id || a)), slotLiberi: e.d.slotLiberi,
      postiNonAssegnati: e.d.postiNonAssegnati || null,
    })) }, null, 1));
})().catch(e => { console.error('ERRORE', e && e.stack || e); process.exit(1); });

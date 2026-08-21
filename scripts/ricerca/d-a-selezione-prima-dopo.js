'use strict';
// scripts/ricerca/d-a-selezione-prima-dopo.js — SOLA LETTURA.
// Esegue `SELM.decidiSelezione` — LA FUNZIONE VERA — due volte sugli STESSI ingressi, cambiando solo
// la mappa dei netti: PRIMA `bestNetPerDay` (oggi), DOPO `bestObiettivoPerDay` (la correzione).
// Ogni altro ingresso e' replicato da `agent41:2376-2464`. Un ingresso replicato male sbaglia
// ENTRAMBE le corse allo stesso modo, quindi il DIFF resta valido.
// NIENTE viene scritto fuori da data/ricerca/. Nessun ordine, nessuno stato, nessun processo toccato.
const fs = require('fs'); const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(RADICE, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// ⚠ LE MANOPOLE VIVONO NEL PROCESSO, NON NEL `.env` (§5.1, §5.3). `MAKER_QUOTA_CODA_LUNGA` e
// `MAKER_MERCATI_CONTEMPORANEI` sono dichiarate in `ecosystem.config.js` su agent41 e NON stanno nel
// `.env`: leggerle da li' darebbe 0,12 invece di 0,5, cioe' una simulazione di un bot che non esiste.
// Si leggono da `/proc/<pid>/environ`, la stessa fonte di `scripts/cli/stato.js`.
(() => {
  try {
    const { execFileSync } = require('child_process');
    const lista = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const p41 = (lista || []).find(x => String(x.name || '').startsWith('agent41'));
    if (!p41 || !p41.pid) { console.error('⚠ agent41 non vivo: le manopole restano quelle del .env'); return; }
    const env = fs.readFileSync(`/proc/${p41.pid}/environ`, 'utf8').split('\0');
    for (const kv of env) {
      const i = kv.indexOf('='); if (i <= 0) continue;
      const k = kv.slice(0, i);
      if (/^MAKER_(QUOTA_CODA_LUNGA|MERCATI_CONTEMPORANEI|MAX_HORIZON_DAYS|DISTANZA_)/.test(k)) {
        process.env[k] = kv.slice(i + 1);
        console.log(`  manopola dal processo vivo: ${k}=${process.env[k]}`);
      }
    }
  } catch (e) { console.error('⚠ /proc non leggibile:', e.message); }
})();
const SELM = require(path.join(RADICE, 'lib/maker/selezione-mercati'));
const QUANTI = require(path.join(RADICE, 'lib/maker/quanti-mercati'));
const H = require(path.join(RADICE, 'lib/rewards/horizon'));
const CONC = require(path.join(RADICE, 'lib/rewards/concentration'));
const { regimeFeed } = require(path.join(RADICE, 'lib/maker/auto-reprice'));
const { fileRuntime, NOMI } = require(path.join(RADICE, 'lib/percorsi-runtime'));
const { readVenuePositions } = require(path.join(RADICE, 'lib/safety/venue-positions-snapshot'));

const SIM = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/ricerca/d-a-simulazione-a-secco.json'), 'utf8'));
const board = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/liquidity-rewards.json'), 'utf8')).markets;
const statoFile = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/selezione-mercati.json'), 'utf8'));
const nome = new Map(board.map(m => [String(m.conditionId).toLowerCase(),
  (m.groupItemTitle ? m.groupItemTitle + ' — ' : '') + m.question]));

// ── gli ingressi, come li costruisce agent41 ──────────────────────────────────────────────────
const ora = Date.now();
const orizzonteMassimoOre = (() => { const g = Number(H.maxHorizonDays ? H.maxHorizonDays() : H.MAX_HORIZON_DAYS_DEFAULT); return Number.isFinite(g) && g > 0 ? g * 24 : null; })();
const quanti = QUANTI.quantiMercati();
const codaLungaGiorni = H.LONG_TAIL_DAYS;
const codaLungaFrazione = H.LONG_TAIL_CAP_FRAC;
const tettoPerMercatoUsd = CONC.MARKET_CAP_FIXED_USD;
const pavimentoPremiante = CONC.pavimentoPremiante;
// ⚠ la selezione NON vuole l'array grezzo: vuole la forma di `agent41.posizioniPerSelezione:1235`
const posizioni = (() => {
  let p; try { p = readVenuePositions(); } catch (e) { return { leggibile: false, motivo: e.message, conditionIds: [] }; }
  if (!p || p.readable !== true) return { leggibile: false, motivo: (p && p.reason) || 'snapshot non leggibile', conditionIds: [] };
  const ids = [];
  for (const x of (p.positions || [])) {
    const c = typeof x.conditionId === 'string' ? x.conditionId.trim().toLowerCase() : '';
    const s = Number(x.size);
    if (c && Number.isFinite(s) && s > 0 && !ids.includes(c)) ids.push(c);
  }
  return { leggibile: true, motivo: null, conditionIds: ids };
})();
const quarantena = (() => { try { const q = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/quarantena-venue.json'), 'utf8'));
  return Object.keys(q && q.mercati ? q.mercati : q || {}); } catch { return []; } })();
const bookVivi = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(fileRuntime(NOMI.bookVivi), 'utf8'));
    const mercati = (j && j.markets && typeof j.markets === 'object') ? j.markets : null;
    if (!mercati) return { leggibile: false, motivo: 'lo snapshot dei book non porta `markets`' };
    const reg = regimeFeed(j.feed && typeof j.feed.vitality === 'object' ? j.feed.vitality : null);
    const per = {};
    for (const [id, b] of Object.entries(mercati)) {
      const y = (b && b.yes) || {};
      per[String(id).trim().toLowerCase()] = { live: b && b.live === true,
        ageMs: b && Number.isFinite(b.ageMs) ? b.ageMs : null,
        needsResnapshot: y.needsResnapshot === true || (b && b.needsResnapshot === true),
        tocco: !!(y && (y.bestBid || y.bestAsk)) };
    }
    return { leggibile: true, per, quanti: Object.keys(per).length,
      etaMassimaMs: reg.limite * 1000, regime: reg.regime, feedVivo: reg.regime === 'vivo' };
  } catch (e) { return { leggibile: false, motivo: e.message }; }
})();
// gli ordini vivi VERI, letti dallo snapshot (fail-closed identico ad agent41)
const conOrdiniVivi = (() => {
  try { const { readVenueOrders } = require(path.join(RADICE, 'lib/safety/venue-orders-snapshot'));
    const s = readVenueOrders();
    return s && s.readable === true
      ? { leggibile: true, ids: (s.marketIds || []).map(x => String(x).trim().toLowerCase()) }
      : { leggibile: false };
  } catch { return { leggibile: false }; }
})();

const mappa = (campo) => { const m = {}; for (const r of SIM.righe) if (r[campo] != null) m[r.id] = r[campo]; return m; };
const PRIMA = mappa('vecchio'), DOPO = mappa('nuovo');

function corri(netto, etichetta) {
  const d = SELM.decidiSelezione({ board, stato: statoFile.stato ?? statoFile, posizioni, ora,
    escludi: quarantena, orizzonteMassimoOre, nettoPerMercato: netto, conOrdiniVivi,
    max: quanti.quanti, codaLungaGiorni, bookVivi, codaLungaFrazione, tettoPerMercatoUsd, pavimentoPremiante });
  const nomi = (a) => (a || []).map(x => (nome.get(String(x.id || x).toLowerCase()) || String(x.id || x)).slice(0, 40));
  console.log(`── ${etichetta} · netti forniti: ${Object.keys(netto).length}`);
  console.log('   ok:', d.ok, d.ok ? '' : '· motivo: ' + d.motivo);
  if (!d.ok) return d;
  console.log('   tenuti      :', (d.tenuti || []).length);
  console.log('   entranti    :', nomi(d.entranti).join(' | ') || '—');
  console.log('   SPODESTATI  :', nomi(d.spodestati).join(' | ') || '—');
  console.log('   liberati    :', nomi(d.liberati).join(' | ') || '—');
  console.log('   uscenti     :', nomi(d.uscenti).join(' | ') || '—');
  return d;
}
console.log('quanti mercati:', quanti.quanti, '· ordini vivi leggibili:', conOrdiniVivi.leggibile,
  '· mercati con ordini:', (conOrdiniVivi.ids || []).length, '· posizioni leggibili:', posizioni.leggibile, '· con posizione:', posizioni.conditionIds.length);
console.log('');
const a = corri(PRIMA, 'PRIMA — bestNetPerDay (oggi)');
console.log('');
const b = corri(DOPO, 'DOPO — bestObiettivoPerDay (la correzione)');
console.log('');
const nS = (x) => (x && x.spodestati || []).length;
console.log(`SPODESTAMENTI: prima ${nS(a)} · dopo ${nS(b)}`);
fs.writeFileSync(path.join(RADICE, 'data/ricerca/d-a-selezione-prima-dopo.json'),
  JSON.stringify({ lettoAl: new Date(ora).toISOString(), quanti: quanti.quanti,
    nettiPrima: Object.keys(PRIMA).length, nettiDopo: Object.keys(DOPO).length,
    prima: { ok: a.ok, motivo: a.motivo || null, tenuti: a.tenuti, entranti: a.entranti, spodestati: a.spodestati, liberati: a.liberati },
    dopo: { ok: b.ok, motivo: b.motivo || null, tenuti: b.tenuti, entranti: b.entranti, spodestati: b.spodestati, liberati: b.liberati } }, null, 1));
console.log('scritto data/ricerca/d-a-selezione-prima-dopo.json');

// ── CONTROPROVA: uno slot LIBERO. E' la condizione in cui la correzione vale davvero. ───────────
console.log('');
console.log('══ CONTROPROVA — uno slot libero (occupante rimosso dallo stato, in memoria) ══');
const occupanti = Object.keys((statoFile.selezionati) || {});
for (const vittima of occupanti) {
  const st = JSON.parse(JSON.stringify(statoFile));
  delete st.selezionati[vittima];
  const run = (netto) => {
    const d = SELM.decidiSelezione({ board, stato: st.stato ?? st, posizioni, ora, escludi: quarantena,
      orizzonteMassimoOre, nettoPerMercato: netto, conOrdiniVivi, max: quanti.quanti,
      codaLungaGiorni, bookVivi, codaLungaFrazione, tettoPerMercatoUsd, pavimentoPremiante });
    return d.ok ? (d.entranti || []).map(x => (nome.get(String(x.id).toLowerCase()) || x.id).slice(0, 34)) : ['(no: ' + d.motivo.slice(0, 40) + ')'];
  };
  console.log('  slot liberato da', (nome.get(vittima.toLowerCase()) || vittima).slice(0, 30).padEnd(32),
    '\n     PRIMA →', run(PRIMA).join(' | ') || '— NESSUNO',
    '\n     DOPO  →', run(DOPO).join(' | ') || '— NESSUNO');
}

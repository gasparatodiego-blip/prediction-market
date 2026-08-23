'use strict';
// scripts/ricerca/premio-per-fascia-23-agosto.js — SOLA LETTURA.
//
// DOMANDA: il premio di oggi viene dai mercati CORTI (≤48 h alla scadenza all'ingresso) o dai LUNGHI,
// e in quali ore UTC?
//
// ⚠ NIENTE ARITMETICA PARALLELA: il punteggio del venue e la quota si chiedono ai moduli condivisi
// (`lib/rewardScore`, `lib/rewards-normalize`, `lib/reward-operator-estimate`, `lib/banda-premiante`,
// `lib/maker/stima-integrata`), mai ricopiati qui.
//
// ⚠ COSA E' MISURATO E COSA E' RICOSTRUITO — la distinzione e' nel referto, non solo qui:
//   MISURATO   · il tasso AGGREGATO $/giorno campionato da agent40 (`data/stima-campioni.json`) e il
//                suo integrale, con la copertura;
//              · gli ordini a libro per MERCATO minuto per minuto (`data/osservazione-24h.jsonl`);
//              · la scadenza di ogni mercato (board ∪ catalogo di ripiego) e quindi la fascia;
//              · i fill (`data/safety-fills.jsonl`), i merge e le gambe nude (giornale maker).
//   RICOSTRUITO· il premio PER MERCATO: non esiste su disco. Si ricostruisce moltiplicando il capitale
//                a libro di quel mercato per il tasso che i moduli condivisi assegnano a quel mercato,
//                usando il board CORRENTE (unica fotografia disponibile: agent24 riscrive il file, non
//                lo versiona). Assunzione dichiarata: punteggio e concorrenza stazionari nella giornata.

const fs = require('fs');
const path = require('path');
const R = (p) => path.join(__dirname, '..', '..', p);

const { normalizePoly } = require(R('lib/rewards-normalize.js'));
const OPEST = require(R('lib/reward-operator-estimate.js'));
const RS = require(R('lib/rewardScore.js'));
const BANDA = require(R('lib/banda-premiante.js'));
const STIMA = require(R('lib/maker/stima-integrata.js'));

const GIORNO = '2026-08-23';
const T0 = Date.parse(`${GIORNO}T00:00:00.000Z`);
const T24 = T0 + 86400000;
const ORA_MS = 3600000;

const leggiJson = (p) => JSON.parse(fs.readFileSync(R(p), 'utf8'));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · LA POSA REALE, PER FASCIA E PER ORA — misurata da configurazione + riavvii osservati
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// I riavvii di agent40 sono LETTI dal giornale (`op:'preesistenti-fotografia'`, che si scrive solo
// all'avvio): 08:21:56Z, 08:46:30Z, 13:56:44Z, 14:58:01Z. I commit che li accompagnano dicono quale
// distanza e' entrata in servizio a ognuno. Prima del primo riavvio vale la configurazione del 20/08.
const FINESTRE_LUNGHI = [
  { da: T0,                                  a: Date.parse('2026-08-23T08:21:56Z'), fraz: 0.456,     nota: 'da 6839255 (20/08)' },
  { da: Date.parse('2026-08-23T08:21:56Z'),  a: Date.parse('2026-08-23T08:46:30Z'), fraz: 3.5 / 4.5, nota: 'da 3e74081 (08:21)' },
  { da: Date.parse('2026-08-23T08:46:30Z'),  a: T24,                                fraz: 3.0 / 4.5, nota: 'da 44e0a45 (08:46)' },
];
function distanzaLunghiCents(tMs, vCents) {
  const f = (FINESTRE_LUNGHI.find((w) => tMs >= w.da && tMs < w.a) || FINESTRE_LUNGHI[2]).fraz;
  return f * vCents;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · ANAGRAFICA DEI MERCATI: scadenza, regole di venue, punteggio
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const boardRaw = leggiJson('data/liquidity-rewards.json');
const boardNorm = normalizePoly(boardRaw);            // ⇐ la STESSA funzione che produce rewardScore
const scorePerCid = new Map();
for (const r of boardNorm) if (r.rewardScore) scorePerCid.set(r.marketId, r.rewardScore);
const boardPerCid = new Map(boardRaw.markets.map((m) => [m.conditionId, m]));

const catalogo = leggiJson('data/maker-manual-markets.json').markets || {};
const offsets = leggiJson('data/maker-offsets.json').markets || {};
const selez = leggiJson('data/selezione-mercati.json').selezionati || {};

function metaMercato(cid) {
  const b = boardPerCid.get(cid) || null;
  const c = catalogo[cid] || null;
  const endDate = (b && b.endDate) || (c && c.endDate) || null;
  return {
    cid,
    titolo: (b && b.question) || (c && c.question) || null,
    endMs: endDate ? Date.parse(endDate) : null,
    endFonte: b ? 'board' : (c ? 'catalogo-di-ripiego' : null),
    vCents: BANDA.raggioBandaCents((b && b.rewardsMaxSpread) ?? (c && c.rewardsMaxSpreadCents)),
    minSize: (b && b.rewardsMinSize) ?? (c && c.rewardsMinSize) ?? null,
    poolDay: (b && b.rewardsDailyRate) ?? (c && c.rewardsDailyRate) ?? null,
    mid: (b && b.mid) ?? (c && c.mid) ?? null,
    depthInBandUsd: b ? b.existing_depth_usd : null,
    score: scorePerCid.get(cid) || null,
    inOffsetsCorta: !!offsets[cid],
    offsetCents: offsets[cid] ? (offsets[cid].targetOffsetCents || {}).yes ?? null : null,
    entratoAt: selez[cid] ? selez[cid].entratoAt : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · IL LIBRO, MINUTO PER MINUTO — misurato
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// `data/osservazione-24h.jsonl` porta, per ogni campione, il libro per MERCATO (ordini, nozionale).
// La sua fonte e' «ricostruita-dal-giornale» e viene confrontata a ogni campione con l'elenco
// AUTOREVOLE letto dal venue: si registra la concordanza invece di darla per scontata.
const campioni = [];
let primaVistaGlobale = new Map();   // cid -> primo istante MAI osservato (anche prima di oggi)
let divConcordi = 0; let divTot = 0;
for (const linea of fs.readFileSync(R('data/osservazione-24h.jsonl'), 'utf8').split('\n')) {
  if (!linea) continue;
  let d; try { d = JSON.parse(linea); } catch { continue; }
  const t = d.at;
  if (!fin(t)) continue;
  const mercati = (d.libro && d.libro.mercati) || {};
  for (const cid of Object.keys(mercati)) {
    if (!primaVistaGlobale.has(cid)) primaVistaGlobale.set(cid, t);
  }
  if (t < T0 || t >= T24) continue;
  const dv = d.divergenza || {};
  if (dv.calcolabile === true) { divTot++; if (dv.concordi === true) divConcordi++; }
  campioni.push({ t, mercati });
}
campioni.sort((a, b) => a.t - b.t);

// ── VALIDAZIONE: il nozionale ricostruito e' davvero il capitale IN BANDA? ───────────────────────
// `stima-campioni.json` porta `c` = `committedInBandUsd` di `buildSummary`, cioe' la grandezza che il
// tasso usa davvero. Se il nozionale dell'osservatore le sta appiccicato, usarlo come capitale della
// ricostruzione e' lecito; se diverge, la ricostruzione sta prezzando capitale FUORI banda.
const campStimaPerVal = STIMA.campioniDi(GIORNO);
const coppieVal = [];
for (const cs of campStimaPerVal) {
  if (!fin(cs.c)) continue;
  let best = null;
  for (const o of campioni) { const dd = Math.abs(o.t - cs.t); if (dd <= 60000 && (best == null || dd < best.d)) best = { d: dd, o }; }
  if (!best) continue;
  const tot = Object.values(best.o.mercati).reduce((a, v) => a + (Number(v.nozionaleUsd) || 0), 0);
  coppieVal.push({ inBanda: cs.c, osservatore: +tot.toFixed(2) });
}
const validazioneInBanda = (() => {
  const n = coppieVal.length;
  if (!n) return { coppie: 0 };
  const scarti = coppieVal.filter((x) => x.inBanda > 0).map((x) => (x.osservatore - x.inBanda) / x.inBanda);
  scarti.sort((a, b) => a - b);
  const med = scarti.length ? scarti[Math.floor(scarti.length / 2)] : null;
  const entro5 = scarti.filter((x) => Math.abs(x) <= 0.05).length;
  return { coppie: n, conCapitaleInBandaPositivo: scarti.length,
    scartoMedianoPct: med == null ? null : +(med * 100).toFixed(2),
    frazioneEntro5pct: scarti.length ? +(entro5 / scarti.length).toFixed(3) : null };
})();

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · LA FASCIA — «sotto 48 h ALL'INGRESSO»
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// L'ingresso si prende, in ordine di forza della prova: `entratoAt` della selezione (scritto da
// agent41 quando il mercato entra) → prima osservazione MAI vista nel giornale dell'osservatore →
// primo campione di oggi (limite superiore: l'ingresso e' quello o prima, quindi la fascia calcolata
// e' una SOTTOSTIMA delle ore alla scadenza, cioe' sbaglia verso «corto»: si dichiara).
const ORIZZONTE_CORTO_H = 48;
function fasciaDi(m) {
  // ORE ALLA SCADENZA ALL'INGRESSO — calcolate, per il riscontro.
  let ingresso = null; let fonteIngresso = null;
  if (fin(m.entratoAt)) { ingresso = m.entratoAt; fonteIngresso = 'selezione.entratoAt'; }
  else if (primaVistaGlobale.has(m.cid)) { ingresso = primaVistaGlobale.get(m.cid); fonteIngresso = 'prima-osservazione (limite superiore: l\'ingresso vero puo\' essere prima, quindi le ore sono una SOTTOSTIMA)'; }
  const ore = (ingresso != null && m.endMs != null) ? (m.endMs - ingresso) / ORA_MS : null;
  const calcolata = ore == null ? null : (ore <= ORIZZONTE_CORTO_H ? 'CORTI' : 'LUNGHI');

  // ⚠ LA FASCIA NON SI DEDUCE SE IL BOT L'HA GIA' SCRITTA. `data/maker-offsets.json` porta un record
  // «fascia corta» scritto da agent41 NELL'ISTANTE DELL'INGRESSO (agent41:2840), cioe' e' il giudizio
  // dello stesso codice che quota: e' una PROVA, non una ricostruzione. Vale solo in un verso — il
  // file si scrive solo sui corti (agent41:2815) — quindi la sua assenza non dimostra «lungo», e per
  // quel caso si ricade sul calcolo.
  if (m.inOffsetsCorta) {
    return { fascia: 'CORTI', ore, fonte: 'maker-offsets (scritta all\'ingresso)', fasciaCalcolata: calcolata, concorde: calcolata == null ? null : calcolata === 'CORTI' };
  }
  if (calcolata == null) return { fascia: null, ore: null, fonte: fonteIngresso || 'ignota', fasciaCalcolata: null, concorde: null };
  return { fascia: calcolata, ore, fonte: fonteIngresso, fasciaCalcolata: calcolata, concorde: null };
}

const meta = new Map();
const tuttiCid = new Set();
for (const c of campioni) for (const cid of Object.keys(c.mercati)) tuttiCid.add(cid);
for (const cid of tuttiCid) {
  const m = metaMercato(cid);
  Object.assign(m, fasciaDi(m));
  meta.set(cid, m);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5 · IL TASSO PER MERCATO — ricostruito con i moduli condivisi
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// VARIANTE A — «come lo stima il bot»: `estimateAtCapital`, cioe' `poolDay × refShare` riscalata al
//   capitale vero. `refShare` e' scorata a `d = v/4` (lib/rewards-normalize.js:137), cioe' S = 0,5625.
// VARIANTE B — «alla posa che il bot tiene davvero»: la STESSA `quadraticUserShare`, con la distanza
//   che quel mercato ha davvero come bersaglio in quell'istante. Non e' un secondo modello: e' la
//   stessa funzione con l'argomento giusto.
let depthCapMorde = 0; let depthCapTot = 0;
/** @returns {{usd:number|null, sottoMinimo:boolean}} */
function tassoA(m, capitaleUsd) {
  const e = OPEST.estimateAtCapital(m.score, capitaleUsd, m.depthInBandUsd);
  if (!e.unknown) { depthCapTot++; if (e.depthLimited) depthCapMorde++; }
  return { usd: e.unknown ? null : e.estUsdPerDay, sottoMinimo: e.belowVenueMinSize === true };
}
/** A' — la STESSA funzione di B, ma alla posa che refShare assume (d = v/4). Isola l'effetto POSA:
 *  A' e B differiscono per il solo argomento `d`, niente altro. */
function tassoAprimo(m, capitaleUsd) {
  if (!m.score || !fin(m.poolDay) || m.vCents == null) return null;
  const q = RS.quadraticUserShare(m.score.competitorQ, m.score.mid, m.vCents, m.minSize || 0, capitaleUsd, m.vCents / 4);
  return q == null ? null : m.poolDay * q;
}
function distanzaBersaglioCents(m, tMs) {
  if (m.vCents == null) return null;
  if (m.fascia === 'CORTI' && fin(m.offsetCents)) return m.offsetCents;   // scritta all'ingresso, letta senza riavvio
  return distanzaLunghiCents(tMs, m.vCents);
}
function tassoB(m, capitaleUsd, tMs) {
  if (!m.score || !fin(m.poolDay)) return null;
  const d = distanzaBersaglioCents(m, tMs);
  if (d == null) return null;
  const q = RS.quadraticUserShare(m.score.competitorQ, m.score.mid, m.vCents, m.minSize || 0, capitaleUsd, d);
  return q == null ? null : m.poolDay * q;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6 · L'INTEGRALE ORARIO — stessa regola di `stima-integrata`: un campione vale fino al successivo,
//     mai oltre due passi. Il passo dell'osservatore e' ~60 s ⇒ estensione massima 120 s.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ── LA FINESTRA COPERTA DAL CAMPIONATORE AGGREGATO ──────────────────────────────────────────────
// Il confronto del §2 dev'essere OMOGENEO: la ricostruzione copre quasi tutta la giornata, il
// campionatore no. Si confronta la ricostruzione ristretta agli stessi intervalli.
const campStima = STIMA.campioniDi(GIORNO);
const estMaxStima = STIMA.estensioneMaxMs();
const intervalliCamp = [];
for (let i = 0; i < campStima.length; i++) {
  const inizio = Math.max(T0, campStima[i].t);
  const prossimo = (i + 1 < campStima.length) ? campStima[i + 1].t : Infinity;
  const fine = Math.min(prossimo, inizio + estMaxStima, T24);
  if (fine > inizio) intervalliCamp.push([inizio, fine]);
}
function copertoDalCampionatore(t) {
  for (const [a, b] of intervalliCamp) if (t >= a && t < b) return true;
  return false;
}
let ricostrA_suFinestraCampionatore = 0;
const premioPerMercato = new Map();

const EST_MAX_MS = 120000;
const ore = [];
for (let h = 0; h < 24; h++) {
  ore.push({ h, CORTI: vuoto(), LUNGHI: vuoto(), IGNOTA: vuoto(), copertoMs: 0 });
}
function vuoto() {
  return { premioA: 0, premioAp: 0, premioB: 0, capOreUsd: 0, capOreSottoMinimo: 0, nonScorabileCapOre: 0, mercati: new Set(), ordiniPesati: 0, pesoMs: 0 };
}

for (let i = 0; i < campioni.length; i++) {
  const c = campioni[i];
  const prossimo = (i + 1 < campioni.length) ? campioni[i + 1].t : Infinity;
  const durata = Math.max(0, Math.min(prossimo, c.t + EST_MAX_MS, T24) - c.t);
  if (durata <= 0) continue;
  const h = Math.floor((c.t - T0) / ORA_MS);
  if (h < 0 || h > 23) continue;
  ore[h].copertoMs += durata;
  for (const [cid, v] of Object.entries(c.mercati)) {
    const m = meta.get(cid); if (!m) continue;
    const cap = Number(v.nozionaleUsd) || 0;
    const ord = Number(v.ordini) || 0;
    const b = ore[h][m.fascia || 'IGNOTA'];
    const frazGiorno = durata / 86400000;
    const ra = tassoA(m, cap); const a = ra.usd;
    const ap = tassoAprimo(m, cap);
    const bb = tassoB(m, cap, c.t);
    if (a != null) b.premioA += a * frazGiorno; else b.nonScorabileCapOre += cap * durata / ORA_MS;
    if (ra.sottoMinimo) b.capOreSottoMinimo += cap * durata / ORA_MS;
    if (ap != null) b.premioAp += ap * frazGiorno;
    if (bb != null) b.premioB += bb * frazGiorno;
    if (copertoDalCampionatore(c.t)) { ricostrA_suFinestraCampionatore += (a != null ? a * frazGiorno : 0); }
    // per-mercato, per il §3/§6: chi produce davvero il premio
    let pm = premioPerMercato.get(cid);
    if (!pm) { pm = { A: 0, B: 0, capOre: 0, sottoMin: 0 }; premioPerMercato.set(cid, pm); }
    pm.A += (a != null ? a * frazGiorno : 0); pm.B += (bb != null ? bb * frazGiorno : 0);
    pm.capOre += cap * durata / ORA_MS; if (ra.sottoMinimo) pm.sottoMin += cap * durata / ORA_MS;
    b.capOreUsd += cap * durata / ORA_MS;
    b.mercati.add(cid);
    b.ordiniPesati += ord * durata; b.pesoMs += durata;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 7 · LA VERIFICA — l'integrale AGGREGATO misurato da agent40, e il consuntivo del venue
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const integ = STIMA.integra({ giorno: GIORNO, now: Date.now() });
const confronto = leggiJson('data/confronto-reward.json');
const giorniConf = (confronto.giorni || []).slice().sort((a, b) => a.giorno.localeCompare(b.giorno));

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 8 · IL COSTO — fill, merge, gambe nude, P&L
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const tokenACid = new Map();
for (const [cid, c] of Object.entries(catalogo)) {
  if (c.tokenIdYes) tokenACid.set(String(c.tokenIdYes), cid);
  if (c.tokenIdNo) tokenACid.set(String(c.tokenIdNo), cid);
}
for (const m of boardRaw.markets) {
  if (m.tokenId) tokenACid.set(String(m.tokenId), m.conditionId);
  if (m.tokenIdNo) tokenACid.set(String(m.tokenIdNo), m.conditionId);
}

const fills = [];
for (const linea of fs.readFileSync(R('data/safety-fills.jsonl'), 'utf8').split('\n')) {
  if (!linea || linea.indexOf('"fill"') < 0) continue;
  let d; try { d = JSON.parse(linea); } catch { continue; }
  if (d.kind !== 'fill' || !(d.ts >= T0 && d.ts < T24)) continue;
  const cid = tokenACid.get(String(d.tokenId)) || null;
  const m = cid ? meta.get(cid) : null;
  fills.push({ ts: d.ts, cid, fascia: m ? (m.fascia || 'IGNOTA') : 'NON-RISOLTO', side: d.side,
    size: d.filledSize, prezzo: d.filledPrice, usd: (d.filledSize || 0) * (d.filledPrice || 0),
    titolo: m ? m.titolo : null });
}

// merge / gambe nude / abbandoni: dal giornale maker del giorno (gia' estratto a parte per costo)
const AUDIT_OGGI = process.env.AUDIT_OGGI || '';
const costi = { perFascia: {}, mergeEseguiti: [], abbandoni: [] };
function bucketCosto(f) {
  if (!costi.perFascia[f]) costi.perFascia[f] = { mergeEseguiti: 0, mergeShare: 0, scopertoGrave: 0, abbandonate: 0, chiusureEseguite: 0 };
  return costi.perFascia[f];
}
if (AUDIT_OGGI && fs.existsSync(AUDIT_OGGI)) {
  const righe = fs.readFileSync(AUDIT_OGGI, 'utf8').split('\n');
  for (const linea of righe) {
    if (!linea) continue;
    if (linea.indexOf('"auto-close"') < 0 && linea.indexOf('"close"') < 0) continue;
    let d; try { d = JSON.parse(linea); } catch { continue; }
    const cid = String(d.marketRef || '').replace('cid_', '0x');
    const m = meta.get(cid);
    const f = m ? (m.fascia || 'IGNOTA') : 'NON-RISOLTO';
    const b = bucketCosto(f);
    const o = d.outcome || '';
    const obs = d.observed || {};
    if (d.op === 'auto-close' && o === 'merge-onchain-eseguito') {
      b.mergeEseguiti++; b.mergeShare += Number(obs.size) || 0;
      costi.mergeEseguiti.push({ tsIso: new Date(d.ts).toISOString(), cid, fascia: f, size: obs.size, collateraleUsd: Number(obs.size) || 0, titolo: m ? m.titolo : null });
    }
    if (d.op === 'auto-close' && o === 'merge-onchain-fallito') b.mergeFalliti = (b.mergeFalliti || 0) + 1;
    if (d.op === 'auto-close' && o === 'scoperto-oltre-soglia-grave') b.scopertoGrave++;
    if (d.op === 'auto-close' && o === 'posizione-abbandonata-dichiarata') { b.abbandonate++; costi.abbandoni.push({ tsIso: new Date(d.ts).toISOString(), cid, fascia: f, reason: (d.reason || '').slice(0, 200) }); }
    if (d.op === 'close' && d.outcome === 'ok') b.chiusureEseguite++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 9 · REFERTO
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function serializza(b) {
  return {
    premioRicostruitoA_Usd: +b.premioA.toFixed(4),
    premioRicostruitoAprimo_Usd: +b.premioAp.toFixed(4),
    premioRicostruitoB_Usd: +b.premioB.toFixed(4),
    capitaleOreUsd: +b.capOreUsd.toFixed(2),
    capitaleOreNonScorabileUsd: +b.nonScorabileCapOre.toFixed(2),
    capitaleOreSottoMinimoVenueUsd: +b.capOreSottoMinimo.toFixed(2),
    frazioneCapitaleOreSottoMinimo: b.capOreUsd > 0 ? +(b.capOreSottoMinimo / b.capOreUsd).toFixed(4) : null,
    mercatiAttivi: b.mercati.size,
    ordiniMedi: b.pesoMs > 0 ? +(b.ordiniPesati / b.pesoMs).toFixed(2) : 0,
    nozionaleMedioUsd: b.pesoMs > 0 ? +(b.capOreUsd * ORA_MS / b.pesoMs).toFixed(2) : 0,
    premioPerDollaroOraA: b.capOreUsd > 0 ? +(b.premioA / b.capOreUsd).toFixed(6) : null,
    premioPerDollaroOraAprimo: b.capOreUsd > 0 ? +(b.premioAp / b.capOreUsd).toFixed(6) : null,
    premioPerDollaroOraB: b.capOreUsd > 0 ? +(b.premioB / b.capOreUsd).toFixed(6) : null,
  };
}

const totali = { CORTI: vuoto(), LUNGHI: vuoto(), IGNOTA: vuoto() };
for (const o of ore) for (const f of ['CORTI', 'LUNGHI', 'IGNOTA']) {
  const s = totali[f]; const b = o[f];
  s.premioA += b.premioA; s.premioAp += b.premioAp; s.premioB += b.premioB; s.capOreUsd += b.capOreUsd;
  s.capOreSottoMinimo += b.capOreSottoMinimo;
  s.nonScorabileCapOre += b.nonScorabileCapOre;
  for (const x of b.mercati) s.mercati.add(x);
  s.ordiniPesati += b.ordiniPesati; s.pesoMs += b.pesoMs;
}

const mercatiTab = [...meta.values()].map((m) => {
  let oreLibro = 0;
  for (const o of ore) for (const f of ['CORTI', 'LUNGHI', 'IGNOTA']) void f;
  return {
    cid: m.cid, titolo: m.titolo, fascia: m.fascia, oreAllaScadenzaAllIngresso: m.ore == null ? null : +m.ore.toFixed(1),
    fonteIngresso: m.fonte, fasciaCalcolata: m.fasciaCalcolata, concordeConIlCalcolo: m.concorde,
    endFonte: m.endFonte, scorabile: !!m.score,
    inOffsetsCorta: m.inOffsetsCorta, offsetCents: m.offsetCents,
    vCents: m.vCents, minSize: m.minSize, poolDayUsd: m.poolDay,
  };
}).sort((a, b) => String(a.fascia).localeCompare(String(b.fascia)) || String(b.titolo).localeCompare(String(a.titolo)));

// ore in cui i CORTI hanno reso piu' dei LUNGHI a parita' di capitale impiegato
const oreVinteCorti = [];
for (const o of ore) {
  const c = o.CORTI; const l = o.LUNGHI;
  if (c.capOreUsd <= 0 || l.capOreUsd <= 0) continue;
  const rc = c.premioB / c.capOreUsd; const rl = l.premioB / l.capOreUsd;
  if (rc > rl) oreVinteCorti.push({ ora: o.h, corti: +rc.toFixed(6), lunghi: +rl.toFixed(6), rapporto: +(rc / rl).toFixed(2) });
}

const out = {
  generatoIso: new Date().toISOString(),
  giorno: GIORNO,
  perimetro: 'sola lettura',
  base: {
    formula: 'estUsdPerDay = poolDay × share; share = quadraticUserShare(Qconcorrenti, mid, v, minSize, capitale, d) con S(v,s)=((v−s)/v)² — lib/rewardScore.js',
    sorgenteTasso: 'lib/reward-operator-estimate.estimateAtCapital ← rewardScore.refShare ← lib/rewards-normalize.js:137',
    posaAssuntaDaRefShare: 'd = v/4 ⇒ S = 0,5625 (v e\' la SEMIAMPIEZZA, lib/banda-premiante)',
    posaRealeDelBot: FINESTRE_LUNGHI.map((w) => ({ da: new Date(w.da).toISOString(), a: new Date(Math.min(w.a, T24)).toISOString(), lunghiCents: +(w.fraz * 4.5).toFixed(3), nota: w.nota })),
    campionatoreAggregato: 'data/stima-campioni.json — SOLO il tasso aggregato, nessuna scomposizione per mercato',
  },
  verifica: {
    integraleAggregatoMisuratoUsd: integ.usd,
    coperturaFrazione: integ.coperturaFrazione,
    campioni: integ.campioni,
    completo: integ.completo,
    consuntivoVenueOggi: 'non leggibile: il venue paga il giorno dopo (v. giorniConfronto)',
    giorniConfronto: giorniConf.map((g) => ({ giorno: g.giorno, integrata: g.stimaIntegrataUsd, copertura: g.stimaCopertura, reale: g.realeUsd, disponibile: g.realeDisponibile, rapporto: (fin(g.realeUsd) && g.realeUsd > 0 && fin(g.stimaIntegrataUsd)) ? +(g.stimaIntegrataUsd / g.realeUsd).toFixed(2) : null })),
    confrontoOmogeneo: {
      nota: 'ricostruzione A ristretta agli STESSI intervalli che il campionatore aggregato copre',
      ricostruzioneA_Usd: +ricostrA_suFinestraCampionatore.toFixed(4),
      campionatoreAggregato_Usd: integ.usd,
      scartoPct: integ.usd > 0 ? +(((ricostrA_suFinestraCampionatore - integ.usd) / integ.usd) * 100).toFixed(1) : null,
    },
    nozionaleOsservatoreVsCapitaleInBanda: validazioneInBanda,
    tettoProfonditaInBanda: { valutazioni: depthCapTot, limitate: depthCapMorde,
      frazione: depthCapTot ? +(depthCapMorde / depthCapTot).toFixed(4) : null },
    libroRicostruitoVsAutorevole: { campioniConfrontabili: divTot, concordi: divConcordi, frazione: divTot ? +(divConcordi / divTot).toFixed(4) : null },
  },
  totaliPerFascia: {
    CORTI: serializza(totali.CORTI),
    LUNGHI: serializza(totali.LUNGHI),
    IGNOTA: serializza(totali.IGNOTA),
  },
  oreVinteDaiCorti: oreVinteCorti,
  tabellaOraria: ore.map((o) => ({
    oraUTC: o.h,
    coperturaOsservatore: +(o.copertoMs / ORA_MS).toFixed(3),
    CORTI: serializza(o.CORTI),
    LUNGHI: serializza(o.LUNGHI),
    IGNOTA: serializza(o.IGNOTA),
  })),
  campione: {
    mercatiCorti: [...meta.values()].filter((m) => m.fascia === 'CORTI').length,
    mercatiLunghi: [...meta.values()].filter((m) => m.fascia === 'LUNGHI').length,
    mercatiSenzaFascia: [...meta.values()].filter((m) => !m.fascia).length,
    oreLibroPerMercatoCorto: null,
  },
  // ── SENSIBILITA': quanto della conclusione regge su UN mercato solo ─────────────────────────────
  sensibilita: (() => {
    const corti = [...premioPerMercato.entries()].filter(([cid]) => (meta.get(cid) || {}).fascia === 'CORTI')
      .map(([cid, v]) => ({ cid, titolo: (meta.get(cid) || {}).titolo, B: v.B, capOre: v.capOre }))
      .sort((a, b) => b.B - a.B);
    const tot = corti.reduce((a, x) => a + x.B, 0);
    const totCap = corti.reduce((a, x) => a + x.capOre, 0);
    const primo = corti[0] || { B: 0, capOre: 0, titolo: null };
    const senzaPrimo = { B: tot - primo.B, capOre: totCap - primo.capOre };
    const rl = totali.LUNGHI.capOreUsd > 0 ? totali.LUNGHI.premioB / totali.LUNGHI.capOreUsd : null;
    return {
      mercatoDominanteCorti: { titolo: primo.titolo, premioB: +primo.B.toFixed(4), capitaleOre: +primo.capOre.toFixed(1),
        quotaDelPremioCorti: tot > 0 ? +(primo.B / tot).toFixed(4) : null,
        premioPerDollaroOraB: primo.capOre > 0 ? +(primo.B / primo.capOre).toFixed(6) : null },
      cortiSenzaIlDominante: { premioB: +senzaPrimo.B.toFixed(4), capitaleOre: +senzaPrimo.capOre.toFixed(1),
        premioPerDollaroOraB: senzaPrimo.capOre > 0 ? +(senzaPrimo.B / senzaPrimo.capOre).toFixed(6) : null },
      lunghiPremioPerDollaroOraB: rl == null ? null : +rl.toFixed(6),
      verdettoSenzaIlDominante: (senzaPrimo.capOre > 0 && rl != null)
        ? ((senzaPrimo.B / senzaPrimo.capOre) > rl ? 'i corti restano avanti' : 'i corti NON sono piu\' avanti')
        : 'non calcolabile',
    };
  })(),
  mercati: mercatiTab,
  premioPerMercato: [...premioPerMercato.entries()].map(([cid, v]) => ({
    cid, titolo: (meta.get(cid) || {}).titolo, fascia: (meta.get(cid) || {}).fascia,
    premioA_Usd: +v.A.toFixed(4), premioB_Usd: +v.B.toFixed(4),
    capitaleOreUsd: +v.capOre.toFixed(2),
    capOreSottoMinimoUsd: +v.sottoMin.toFixed(2),
    premioPerDollaroOraB: v.capOre > 0 ? +(v.B / v.capOre).toFixed(6) : null,
  })).sort((a, b) => b.premioB_Usd - a.premioB_Usd),
  costo: { fillOggi: fills, perFascia: costi.perFascia, mergeEseguiti: costi.mergeEseguiti, abbandoni: costi.abbandoni,
    portafoglio: portafoglio() },
};

function portafoglio() {
  // Il P&L di TRADING della giornata, al netto: il premio di oggi NON e' ancora accreditato (il venue
  // paga il giorno dopo, v. reward-reale), e non ci sono depositi. Quindi la variazione del totale di
  // portafoglio nella giornata E' il P&L di trading — a livello di PORTAFOGLIO, non di fascia.
  const righe = fs.readFileSync(R('data/osservatore/campioni-' + GIORNO + '.jsonl'), 'utf8').split('\n');
  let primo = null; let ultimo = null;
  for (const l of righe) {
    if (!l) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (!fin(d.totalePortafoglioUsd)) continue;
    if (!primo) primo = d; ultimo = d;
  }
  if (!primo || !ultimo) return { misurabile: false, motivo: 'nessun campione con totale leggibile' };
  return {
    misurabile: true,
    apertura: { iso: primo.atIso, totaleUsd: primo.totalePortafoglioUsd, saldoUsd: primo.saldoUsd, posizioniUsd: primo.posizioniValoreUsd },
    ultimo: { iso: ultimo.atIso, totaleUsd: ultimo.totalePortafoglioUsd, saldoUsd: ultimo.saldoUsd, posizioniUsd: ultimo.posizioniValoreUsd },
    deltaUsd: +(ultimo.totalePortafoglioUsd - primo.totalePortafoglioUsd).toFixed(4),
    nota: 'delta di PORTAFOGLIO, non scomponibile per fascia: oggi ci sono 12 fill tutti BUY e zero SELL riempiti, quindi non esiste una coppia entrata/uscita da attribuire',
  };
}

// ore-libro per mercato corto (per §6)
{
  const oreCid = new Map();
  for (let i = 0; i < campioni.length; i++) {
    const c = campioni[i];
    const prossimo = (i + 1 < campioni.length) ? campioni[i + 1].t : Infinity;
    const durata = Math.max(0, Math.min(prossimo, c.t + EST_MAX_MS, T24) - c.t);
    for (const cid of Object.keys(c.mercati)) oreCid.set(cid, (oreCid.get(cid) || 0) + durata / ORA_MS);
  }
  out.campione.oreLibroPerMercatoCorto = [...meta.values()].filter((m) => m.fascia === 'CORTI')
    .map((m) => ({ cid: m.cid, titolo: m.titolo, ore: +(oreCid.get(m.cid) || 0).toFixed(2), scorabile: !!m.score }))
    .sort((a, b) => b.ore - a.ore);
  out.campione.oreLibroPerMercatoLungo = [...meta.values()].filter((m) => m.fascia === 'LUNGHI')
    .map((m) => ({ cid: m.cid, titolo: m.titolo, ore: +(oreCid.get(m.cid) || 0).toFixed(2), scorabile: !!m.score }))
    .sort((a, b) => b.ore - a.ore);
}

const dest = R('data/ricerca/premio-per-fascia-23-agosto.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log('scritto', dest);
console.log(JSON.stringify(out.verifica, null, 1));
console.log('TOTALI', JSON.stringify(out.totaliPerFascia, null, 1));

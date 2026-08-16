#!/usr/bin/env node
'use strict';
// scripts/ricerca/wallet-52870486.js — IL PIÙ ANZIANO DEI QUATTRO, GUARDATO DA VICINO.
//
//   node scripts/ricerca/wallet-52870486.js
//   node scripts/ricerca/wallet-52870486.js --wallet 0x…    (lo stesso lavoro su un altro)
//
// SOLA LETTURA. Nessun ordine, nessuna firma, nessuna transazione. Passa da `screening-lib.js` (la
// corsia di ricerca isolata) e da `lib/maker/selezione-mercati.js`, che è puro — zero `require` — e
// serve per rispondere alla domanda 6 con i VINCOLI VERI del bot invece che con una loro copia.
//
// ═══ I METODI SONO QUELLI GIÀ TARATI, NON NUOVI ══════════════════════════════════════════════════
// Ogni misura qui riusa un metodo già pagato in questo repo, per non introdurre una seconda
// definizione della stessa cosa:
//   · maker vs taker → differenza fra `/trades?takerOnly=false` e `takerOnly=true` (§5-bis p.162);
//   · fusione dei fill parziali → raggruppa-poi-fondi, mai «confronta con la riga precedente»
//     (§5-bis p.162: quel modo produsse 2.049 eventi fantasma in classe D);
//   · classi di uscita A/B/C/D/E → la STESSA funzione di `screening-05-uscite.js`;
//   · distanza dal mid → `prices-history` a `fidelity=1`, campione STRETTAMENTE precedente il fill e
//     scartato oltre 180 s (`efficienti-02`);
//   · montepremi vero → `rewards.rates` del CLOB, non `rewardsMinSize` di Gamma: la banda può essere
//     configurata su un piatto vuoto, ed è il caso di tutti i «Up or Down».
//
// ⚠ I PREZZI ARRIVANO CON RUMORE DI VIRGOLA MOBILE (`0.8599999965` per `0.86`): si arrotonda a 4
// decimali prima di raggruppare, o due pezzi dello stesso ordine finiscono in gruppi diversi.

const { apiGet, inParallelo, scrivi, leggi, mediana, contatore } = require('./screening-lib');
const SEL = require('../../lib/maker/selezione-mercati');

const argomenti = process.argv.slice(2);
const val = (n, d) => { const i = argomenti.indexOf(n); return i >= 0 && argomenti[i + 1] ? argomenti[i + 1] : d; };
const WALLET = String(val('--wallet', '0x52870486f74fcd2fe707821b9aa8da0f6d8c3a16')).toLowerCase();

const PER_PAGINA = 500;
const PAGINE_MAX = 21;
const FINESTRA_UNIONE_S = 120;
const ORIZZONTE_USCITA_S = 24 * 3600;
const MAX_ETA_MID_S = 180;
const MAX_FILL_MID_PER_MESE = 60;   // campionamento uniforme e dichiarato
const CLOB = 'clob.polymarket.com';
const GAMMA = 'gamma-api.polymarket.com';

const RE_UPDOWN = /(Bitcoin|Ethereum|Solana|XRP|Dogecoin)\s+Up or Down/i;
const RE_METEO = /\btemperature\b|\bweather\b|\bhighest\s+temp|\blowest\s+temp|\d\s*°\s*[cf]\b/i;

const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
function numero(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const v = Number(x); return Number.isFinite(v) ? v : null; }
  return null;
}
const prezzo4 = (p) => Math.round(Number(p) * 1e4) / 1e4;
const mese = (ts) => new Date(ts * 1000).toISOString().slice(0, 7);
const giorno = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

// ── SCARICO ─────────────────────────────────────────────────────────────────────────────────────
async function scarica(soloTaker) {
  const righe = new Map();
  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const r = await apiGet(`/trades?user=${WALLET}&takerOnly=${soloTaker}&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore };
    for (const t of r.dati) righe.set([t.conditionId, t.asset, t.timestamp, prezzo4(t.price), t.size, t.side].join('|'), t);
    if (r.dati.length < PER_PAGINA) break;
  }
  return { ok: true, righe: [...righe.values()] };
}

/** Fonde i fill parziali: raggruppa per (mercato, token, lato, prezzo), poi fonde entro 120 s. */
function unisciParziali(trades) {
  const gruppi = new Map();
  for (const t of trades) {
    const g = [t.conditionId, t.asset, t.side, prezzo4(t.price)].join('|');
    if (!gruppi.has(g)) gruppi.set(g, []);
    gruppi.get(g).push(t);
  }
  const fuori = [];
  for (const [, righe] of gruppi) {
    righe.sort((a, b) => a.timestamp - b.timestamp);
    let cur = null;
    for (const t of righe) {
      if (cur && (t.timestamp - cur.ultimoTs) <= FINESTRA_UNIONE_S) {
        cur.size += Number(t.size); cur.ultimoTs = t.timestamp; cur.pezzi += 1;
        if (t.taker) cur.taker = true;
      } else {
        if (cur) fuori.push(cur);
        cur = { conditionId: normId(t.conditionId), asset: String(t.asset), side: String(t.side).toUpperCase(),
          price: prezzo4(t.price), size: Number(t.size), timestamp: t.timestamp, ultimoTs: t.timestamp,
          outcomeIndex: t.outcomeIndex, outcome: t.outcome, title: t.title || t.slug || null,
          taker: !!t.taker, pezzi: 1 };
      }
    }
    if (cur) fuori.push(cur);
  }
  return fuori.sort((a, b) => a.timestamp - b.timestamp);
}

/** LE CLASSI DI USCITA — la stessa funzione di screening-05, riportata identica. */
function classifica(eventi, tMax, orizzonteS) {
  const perMercato = new Map();
  for (const e of eventi) {
    if (!perMercato.has(e.conditionId)) perMercato.set(e.conditionId, []);
    perMercato.get(e.conditionId).push(e);
  }
  const fuori = []; let censurati = 0;
  for (const [, lista] of perMercato) {
    lista.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < lista.length; i += 1) {
      const e = lista[i];
      if (e.side !== 'BUY') continue;
      let seguito = null;
      for (let j = i + 1; j < lista.length; j += 1) {
        if (lista[j].timestamp <= e.ultimoTs) continue;
        if (lista[j].timestamp - e.ultimoTs > orizzonteS) break;
        seguito = lista[j]; break;
      }
      if (!seguito) {
        if (tMax - e.ultimoTs >= orizzonteS) {
          fuori.push({ classe: 'C', mercato: e.conditionId, ts: e.timestamp, taker: e.taker, size: e.size, prezzo: e.price });
        } else censurati += 1;
        continue;
      }
      const base = { mercato: e.conditionId, ts: e.timestamp, dtSec: seguito.timestamp - e.ultimoTs,
        prezzo: e.price, outcomeIndex: e.outcomeIndex, taker: e.taker, size: e.size, seguitoTaker: seguito.taker };
      if (seguito.side === 'BUY' && seguito.outcomeIndex !== e.outcomeIndex) fuori.push({ ...base, classe: 'A', costoCoppiaCents: (e.price + seguito.price) * 100 });
      else if (seguito.side === 'SELL' && seguito.outcomeIndex === e.outcomeIndex) fuori.push({ ...base, classe: 'B', deltaCents: (seguito.price - e.price) * 100 });
      else if (seguito.side === 'BUY' && seguito.outcomeIndex === e.outcomeIndex) fuori.push({ ...base, classe: 'D' });
      else fuori.push({ ...base, classe: 'E' });
    }
  }
  return { eventi: fuori, censurati };
}

// ── CONFIGURAZIONE DEI MERCATI ──────────────────────────────────────────────────────────────────
async function configurazione(cids) {
  const fuori = new Map();
  // Gamma, DUE passate: di difetto restituisce i soli mercati APERTI (§5-bis p.162).
  for (const suffisso of ['', '&closed=true']) {
    for (let i = 0; i < cids.length; i += 20) {
      const pezzo = cids.slice(i, i + 20).filter((c) => !fuori.has(c));
      if (!pezzo.length) continue;
      const r = await apiGet(`/markets?${pezzo.map((c) => `condition_ids=${c}`).join('&')}${suffisso}`, 0, GAMMA);
      if (!r.ok || !Array.isArray(r.dati)) continue;
      for (const m of r.dati) {
        fuori.set(normId(m.conditionId), {
          titolo: m.question || null, slug: m.slug || null, categoria: m.category || null,
          minSize: numero(m.rewardsMinSize), maxSpread: numero(m.rewardsMaxSpread),
          // ⚠ `liquidity` è la profondità di ADESSO, e su un mercato chiuso Gamma la omette: resta
          // `null` invece di diventare 0. Non esiste una fonte pubblica per il book di un mercato passato.
          liquidita: numero(m.liquidity ?? m.liquidityClob),
          volume24h: numero(m.volume24hr), endDate: m.endDate || null, chiuso: m.closed === true,
        });
      }
    }
  }
  // Il CLOB per il MONTEPREMI VERO: `rates: null` ⇒ nessun premio, per quanto la banda sia configurata.
  await inParallelo(cids, 6, async (cid) => {
    const r = await apiGet(`/markets/${cid}`, 0, CLOB);
    if (!r.ok || !r.dati || !r.dati.condition_id) return null;
    const rt = r.dati.rewards && Array.isArray(r.dati.rewards.rates) && r.dati.rewards.rates[0];
    const c = fuori.get(normId(cid)) || {};
    c.rateVero = rt ? numero(rt.rewards_daily_rate) : null;
    c.titolo = c.titolo || r.dati.question || null;
    fuori.set(normId(cid), c);
    return null;
  });
  return fuori;
}

function famiglia(titolo, categoria) {
  const t = String(titolo || '');
  if (RE_UPDOWN.test(t)) return 'cripto-updown';
  if (RE_METEO.test(t)) return 'meteo';
  const c = String(categoria || '').toLowerCase();
  if (/politic|election/.test(c)) return 'politica';
  if (/sport/.test(c)) return 'sport';
  if (/crypto/.test(c)) return 'cripto';
  if (/econom|business/.test(c)) return 'macro';
  return categoria ? String(categoria).toLowerCase() : 'altro';
}

// ── DISTANZA DAL MID ────────────────────────────────────────────────────────────────────────────
async function serieMid(asset, da, a) {
  const r = await apiGet(`/prices-history?market=${asset}&startTs=${da}&endTs=${a}&fidelity=1`, 0, CLOB);
  return (r.ok && r.dati && Array.isArray(r.dati.history)) ? r.dati.history : null;
}
function precedente(serie, ts) {
  let best = null;
  for (const p of serie) { if (p.t < ts && (best === null || p.t > best.t)) best = p; }
  return best;
}

// ── PRINCIPALE ──────────────────────────────────────────────────────────────────────────────────
async function principale() {
  console.log(`wallet ${WALLET}\n`);
  console.log('  [1/6] scarico i trade (tutti e soli-taker)…');
  const tutti = await scarica(false);
  const soloT = await scarica(true);
  if (!tutti.ok || !soloT.ok) { console.error('RIFIUTATO: trade non leggibili'); process.exitCode = 1; return; }

  // L'etichetta maker/taker per differenza, con la cintura: si classifica solo l'intervallo coperto
  // da ENTRAMBE le liste, o un fill fuori copertura sembrerebbe maker per assenza.
  const chiaviTaker = new Set(soloT.righe.map((t) => [t.conditionId, t.asset, t.timestamp, prezzo4(t.price), t.size, t.side].join('|')));
  const tsMinT = Math.min(...soloT.righe.map((t) => t.timestamp));
  const tsMinA = Math.min(...tutti.righe.map((t) => t.timestamp));
  const daClassificare = Math.max(tsMinT, tsMinA);
  const marcati = tutti.righe.map((t) => ({ ...t, taker: chiaviTaker.has([t.conditionId, t.asset, t.timestamp, prezzo4(t.price), t.size, t.side].join('|')) }));
  console.log(`        ${tutti.righe.length} fill · ${soloT.righe.length} taker · copertura maker/taker da ${new Date(daClassificare * 1000).toISOString().slice(0, 10)}`);

  const eventi = unisciParziali(marcati);
  const tMax = Math.max(...eventi.map((e) => e.ultimoTs));
  console.log(`        ${eventi.length} eventi dopo la fusione dei parziali`);

  const cids = [...new Set(eventi.map((e) => e.conditionId))];
  console.log(`  [2/6] configurazione di ${cids.length} mercati…`);
  const cfg = await configurazione(cids);
  console.log(`        ${cfg.size} letti`);

  // ── 1 · MESE PER MESE: dove sta ──────────────────────────────────────────────────────────────
  console.log('  [3/6] composizione mensile…');
  const mesi = new Map();
  for (const e of eventi) {
    const m = mese(e.timestamp);
    if (!mesi.has(m)) mesi.set(m, { eventi: [], mercati: new Set(), giorni: new Set() });
    const q0 = mesi.get(m);
    q0.eventi.push(e); q0.mercati.add(e.conditionId); q0.giorni.add(giorno(e.timestamp));
  }

  const perMese = [...mesi.entries()].sort().map(([m, d]) => {
    const fam = {};
    const oreAllaScadenza = [], maxSp = [], minSz = [], liq = [], capPerMercato = new Map();
    for (const cid of d.mercati) {
      const c = cfg.get(cid) || {};
      const f = famiglia(c.titolo, c.categoria);
      fam[f] = (fam[f] || 0) + 1;
      if (c.maxSpread !== null && c.maxSpread !== undefined) maxSp.push(c.maxSpread);
      if (c.minSize !== null && c.minSize !== undefined) minSz.push(c.minSize);
      if (c.liquidita !== null && c.liquidita !== undefined) liq.push(c.liquidita);
    }
    // La scadenza TIPICA: ore fra il fill e la fine del mercato — è la domanda vera («su che orizzonte
    // lavora»), non la durata nominale del mercato.
    for (const e of d.eventi) {
      const c = cfg.get(e.conditionId) || {};
      const t = c.endDate ? Date.parse(c.endDate) : NaN;
      if (Number.isFinite(t)) oreAllaScadenza.push((t - e.timestamp * 1000) / 3_600_000);
      if (e.side === 'BUY') capPerMercato.set(e.conditionId, (capPerMercato.get(e.conditionId) || 0) + e.size * e.price);
    }
    const cap = [...capPerMercato.values()];
    return {
      mese: m, eventi: d.eventi.length, mercati: d.mercati.size, giorniAttivi: d.giorni.size,
      famiglie: fam,
      oreAllaScadenzaMediana: mediana(oreAllaScadenza), oreQ25: q(oreAllaScadenza, 0.25), oreQ75: q(oreAllaScadenza, 0.75),
      maxSpreadMediano: mediana(maxSp), minSizeMediano: mediana(minSz),
      liquiditaMediana: mediana(liq), liquiditaLette: liq.length, liquiditaMancanti: d.mercati.size - liq.length,
      capitalePerMercatoMediano: mediana(cap), capitaleQ25: q(cap, 0.25), capitaleQ75: q(cap, 0.75),
      capitaleTotale: cap.reduce((a, x) => a + x, 0),
      quotaTaker: d.eventi.length ? d.eventi.filter((e) => e.taker).length / d.eventi.length : null,
    };
  });

  // ── 3 · MERCATI APERTI INSIEME ───────────────────────────────────────────────────────────────
  // Si ricostruisce la posizione per (mercato, token) evento per evento e si campiona a fine giornata:
  // «quanti mercati con posizione netta diversa da zero». Mediana per mese.
  const netto = new Map();
  const apertiPerGiorno = new Map();
  let ultimoGiorno = null;
  for (const e of eventi) {
    const g = giorno(e.timestamp);
    if (ultimoGiorno !== null && g !== ultimoGiorno) {
      const n = contaMercatiAperti(netto);
      apertiPerGiorno.set(ultimoGiorno, n);
    }
    const k = e.conditionId + '|' + e.asset;
    netto.set(k, (netto.get(k) || 0) + (e.side === 'BUY' ? e.size : -e.size));
    ultimoGiorno = g;
  }
  if (ultimoGiorno) apertiPerGiorno.set(ultimoGiorno, contaMercatiAperti(netto));
  for (const p of perMese) {
    const v = [...apertiPerGiorno.entries()].filter(([g]) => g.startsWith(p.mese)).map(([, n]) => n);
    p.mercatiApertiInsiemeMediana = mediana(v);
    p.mercatiApertiInsiemeMax = v.length ? Math.max(...v) : null;
  }

  // ── 2 · DISTANZA DAL MID ─────────────────────────────────────────────────────────────────────
  console.log('  [4/6] distanza dal mid (campione per mese)…');
  for (const p of perMese) {
    const maker = mesi.get(p.mese).eventi.filter((e) => !e.taker && e.timestamp >= daClassificare);
    const passo = maker.length > MAX_FILL_MID_PER_MESE ? maker.length / MAX_FILL_MID_PER_MESE : 1;
    const camp = [];
    for (let i = 0; i < maker.length; i += passo) camp.push(maker[Math.floor(i)]);
    const dist = [];
    let nonMisurati = 0;
    for (const e of camp) {
      const serie = await serieMid(e.asset, e.timestamp - 900, e.timestamp + 300);
      if (!serie || !serie.length) { nonMisurati += 1; continue; }
      const pre = precedente(serie, e.timestamp);
      if (!pre || (e.timestamp - pre.t) > MAX_ETA_MID_S) { nonMisurati += 1; continue; }
      dist.push(Math.abs(e.price - pre.p) * 100);
    }
    p.distanzaMidCentsMediana = mediana(dist);
    p.distanzaQ25 = q(dist, 0.25); p.distanzaQ75 = q(dist, 0.75);
    p.distanzaMisurati = dist.length; p.distanzaNonMisurati = nonMisurati;
    p.makerNelMese = maker.length;
  }

  // ── 4 · LE USCITE ────────────────────────────────────────────────────────────────────────────
  console.log('  [5/6] classi di uscita…');
  const cl = classifica(eventi.filter((e) => e.timestamp >= daClassificare), tMax, ORIZZONTE_USCITA_S);
  const perMeseClassi = {};
  for (const e of cl.eventi) {
    const m = mese(e.ts);
    if (!perMeseClassi[m]) perMeseClassi[m] = { A: 0, B: 0, C: 0, D: 0, E: 0, n: 0, taker: 0 };
    perMeseClassi[m][e.classe] += 1; perMeseClassi[m].n += 1;
    if (e.taker) perMeseClassi[m].taker += 1;
  }
  const totClassi = { A: 0, B: 0, C: 0, D: 0, E: 0, n: cl.eventi.length };
  for (const e of cl.eventi) totClassi[e.classe] += 1;
  const A = cl.eventi.filter((e) => e.classe === 'A');
  const B = cl.eventi.filter((e) => e.classe === 'B');

  // ── 6 · SOVRAPPOSIZIONE COL BOARD E COI VINCOLI DEL BOT ──────────────────────────────────────
  console.log('  [6/6] confronto col board e coi vincoli del bot…');
  const board = leggi('../liquidity-rewards.json') || null;
  return finisci({ perMese, perMeseClassi, totClassi, A, B, cl, cfg, cids, eventi, WALLET, daClassificare, tMax });
}

function contaMercatiAperti(netto) {
  const perMercato = new Map();
  for (const [k, v] of netto) {
    const cid = k.split('|')[0];
    perMercato.set(cid, (perMercato.get(cid) || 0) + Math.abs(v));
  }
  let n = 0;
  for (const [, v] of perMercato) if (v > 1e-6) n += 1;
  return n;
}

function finisci(ctx) {
  const fs = require('fs');
  const path = require('path');
  // Il board vero del bot: i mercati con un montepremi utilizzabile (la stessa soglia di agent24).
  let board = [];
  try { board = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'liquidity-rewards.json'), 'utf8')).markets || []; } catch { board = []; }
  const premianti = board.filter((m) => Number(m.rewardsDailyRate) > 0.01);
  const idBoard = new Set(premianti.map((m) => normId(m.conditionId)));
  const suoi = new Set(ctx.cids);
  const inBoard = [...suoi].filter((c) => idBoard.has(c));

  // Quanti il bot POTREBBE selezionare: si usano le funzioni VERE, non una loro copia.
  const ora = Date.now();
  const selezionabili = premianti.filter((m) => idBoard.has(normId(m.conditionId)) && suoi.has(normId(m.conditionId)))
    .filter((m) => SEL.valutaAmmissibilita(m, { ora }).ammissibile);

  // Il montepremi vero dei suoi mercati (dal CLOB), che è la domanda «quanti pagano davvero».
  let conRate = 0, senzaRate = 0;
  for (const c of ctx.cids) {
    const x = ctx.cfg.get(c) || {};
    if (x.rateVero !== null && x.rateVero !== undefined && x.rateVero > 0.01) conRate += 1; else senzaRate += 1;
  }

  const out = {
    generatoIl: new Date().toISOString(), wallet: ctx.WALLET,
    eventi: ctx.eventi.length, mercati: ctx.cids.length,
    coperturaMakerTakerDa: new Date(ctx.daClassificare * 1000).toISOString(),
    perMese: ctx.perMese, classi: ctx.totClassi, classiPerMese: ctx.perMeseClassi,
    censuratiUscite: ctx.cl.censurati,
    A: { n: ctx.A.length, costoCoppiaMediano: mediana(ctx.A.map((e) => e.costoCoppiaCents)),
      tempoMedianoSec: mediana(ctx.A.map((e) => e.dtSec)),
      quotaCompletamentoTaker: ctx.A.length ? ctx.A.filter((e) => e.seguitoTaker).length / ctx.A.length : null },
    B: { n: ctx.B.length, deltaMediano: mediana(ctx.B.map((e) => e.deltaCents)),
      tempoMedianoSec: mediana(ctx.B.map((e) => e.dtSec)) },
    board: { premiantiNelBoard: premianti.length, suoiNelBoard: inBoard.length,
      selezionabiliDalBot: selezionabili.length,
      selezionabili: selezionabili.map((m) => ({ conditionId: m.conditionId, question: m.question,
        minSize: m.rewardsMinSize, maxSpread: m.rewardsMaxSpread, rate: m.rewardsDailyRate,
        ore: (Date.parse(m.endDate) - ora) / 3600000 })) },
    montepremiVero: { conMontepremi: conRate, senzaMontepremi: senzaRate },
    chiamate: { api: contatore.api, ritentate: contatore.ritentate, errori: contatore.errori },
  };
  const f = scrivi('wallet-52870486.json', out);
  stampa(out);
  console.log(`\n→ ${f}`);
  return out;
}

function stampa(o) {
  const usd = (n) => (n === null || !Number.isFinite(n)) ? 'n/d' : '$' + n.toLocaleString('it-IT', { maximumFractionDigits: 0 });
  const usd2 = (n) => (n === null || !Number.isFinite(n)) ? 'n/d' : '$' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pc = (x) => (x === null || !Number.isFinite(x)) ? 'n/d' : (x * 100).toFixed(0) + '%';
  const nn = (x, d = 1) => (x === null || !Number.isFinite(x)) ? 'n/d' : x.toFixed(d);

  console.log('\n' + '═'.repeat(112));
  console.log(`1 · DOVE STA, MESE PER MESE — ${o.eventi} eventi su ${o.mercati} mercati`);
  console.log('═'.repeat(112));
  console.log('  mese     ev  merc  gg   scadenza tipica     maxSpr  minSz   liquidità     famiglie');
  for (const p of o.perMese) {
    const fam = Object.entries(p.famiglie).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`  ${p.mese}  ${String(p.eventi).padStart(4)} ${String(p.mercati).padStart(5)} ${String(p.giorniAttivi).padStart(3)}   `
      + `${nn(p.oreAllaScadenzaMediana).padStart(7)} h (${nn(p.oreQ25, 0)}–${nn(p.oreQ75, 0)})`.padEnd(22)
      + `${nn(p.maxSpreadMediano).padStart(5)}  ${String(p.minSizeMediano ?? 'n/d').padStart(5)}  ${usd(p.liquiditaMediana).padStart(10)}   ${fam}`);
  }
  console.log('  ⚠ la liquidità è quella di ADESSO: Gamma la omette sui mercati chiusi, quindi le righe vecchie ne hanno poche.');
  console.log('    letture mancanti per mese: ' + o.perMese.map((p) => `${p.mese} ${p.liquiditaMancanti}/${p.mercati}`).join(' · '));

  console.log('\n' + '═'.repeat(112));
  console.log('2 · DISTANZA DAL MID DEI SUOI FILL MAKER (mediana per mese, centesimi)');
  console.log('═'.repeat(112));
  for (const p of o.perMese) {
    console.log(`  ${p.mese}   mediana ${nn(p.distanzaMidCentsMediana, 2).padStart(6)}¢   (q25 ${nn(p.distanzaQ25, 2)} · q75 ${nn(p.distanzaQ75, 2)})   misurati ${p.distanzaMisurati}/${p.distanzaMisurati + p.distanzaNonMisurati}   maker nel mese ${p.makerNelMese}`);
  }

  console.log('\n' + '═'.repeat(112));
  console.log('3 · CAPITALE PER MERCATO E MERCATI APERTI INSIEME');
  console.log('═'.repeat(112));
  console.log('  mese     capitale/mercato (mediana)   q25–q75            totale    aperti insieme (mediana / max)');
  for (const p of o.perMese) {
    console.log(`  ${p.mese}   ${usd2(p.capitalePerMercatoMediano).padStart(12)}          ${(usd2(p.capitaleQ25) + '–' + usd2(p.capitaleQ75)).padEnd(20)} ${usd(p.capitaleTotale).padStart(9)}     ${String(p.mercatiApertiInsiemeMediana).padStart(5)} / ${p.mercatiApertiInsiemeMax}`);
  }

  console.log('\n' + '═'.repeat(112));
  console.log('4 · LE USCITE DOPO IL FILL');
  console.log('═'.repeat(112));
  const nomi = { A: 'A · completa la coppia', B: 'B · rivende lo stesso esito', C: 'C · tiene fino a risoluzione', D: 'D · aumenta sullo stesso lato', E: "E · vende l'altro lato" };
  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    const n = o.classi[k];
    console.log(`  ${nomi[k].padEnd(34)} ${String(n).padStart(5)}  ${o.classi.n ? (100 * n / o.classi.n).toFixed(1) + '%' : 'n/d'}`);
  }
  console.log(`  (${o.censuratiUscite} eventi censurati: troppo recenti per un orizzonte intero)`);
  console.log(`\n  A: costo coppia mediano ${nn(o.A.costoCoppiaMediano, 2)}¢ · tempo mediano ${nn(o.A.tempoMedianoSec / 60, 1)} min · gamba che completa presa da TAKER ${pc(o.A.quotaCompletamentoTaker)}`);
  console.log(`  B: delta mediano ${nn(o.B.deltaMediano, 2)}¢ · tempo mediano ${nn(o.B.tempoMedianoSec / 60, 1)} min`);
  console.log('\n  quota di fill presi in TAKER, per mese:');
  for (const p of o.perMese) console.log(`    ${p.mese}  ${pc(p.quotaTaker)}`);

  console.log('\n' + '═'.repeat(112));
  console.log('6 · I SUOI MERCATI CONTRO IL BOARD E CONTRO I VINCOLI DEL BOT');
  console.log('═'.repeat(112));
  console.log(`  suoi mercati con un montepremi VERO (rate > $0,01/g): ${o.montepremiVero.conMontepremi}/${o.mercati}`);
  console.log(`  mercati premianti nel board di adesso               : ${o.board.premiantiNelBoard}`);
  console.log(`  suoi mercati che stanno nel board di adesso         : ${o.board.suoiNelBoard}`);
  console.log(`  di questi, selezionabili dal bot (minSize≤20, ≥48h, no meteo): ${o.board.selezionabiliDalBot}`);
  for (const s of o.board.selezionabili.slice(0, 10)) {
    console.log(`      ${String(s.question).slice(0, 56)} · minSize ${s.minSize} · banda ${s.maxSpread}¢ · $${s.rate}/g · fra ${(s.ore / 24).toFixed(1)} g`);
  }
}

principale().catch((e) => { console.error('\nGUASTO: ' + (e && e.stack || e)); process.exitCode = 1; });

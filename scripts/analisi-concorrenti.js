#!/usr/bin/env node
'use strict';
// scripts/analisi-concorrenti.js — CHI QUOTA CONTRO DI NOI, E QUANTO RESTA LÌ.
//
// SOLA LETTURA. Non importa nessuna superficie di piazzamento o cancellazione, non interroga il venue
// con credenziali, non scrive niente fuori da `docs/`. Legge tre fonti che il server già raccoglie:
//
//   · il PIANO (json salvato)                    → i mercati scelti, il nostro prezzo, la nostra size
//   · `data/mid-history-<giorno>.jsonl`          → la SCALA del book, 22 livelli, campionata nel tempo
//   · `data/maker-21-eventi.jsonl`               → gli unici dati con IDENTITÀ di wallet
//
// ═══ CIÒ CHE QUESTA ANALISI NON PUÒ FARE, E VA DETTO PRIMA ═════════════════════════════════════════
// Il book del CLOB è AGGREGATO PER LIVELLO DI PREZZO: `bidSizeAtLevel` è la somma di tutti gli ordini
// a quel prezzo, di chiunque siano. Quindi:
//   · «quanti ORDINI distinti» non è misurabile — si contano LIVELLI, e un livello può essere un
//     ordine solo o venti;
//   · l'identità di chi quota NON è nel book. L'unica fonte con wallet è `maker-21-eventi`, che copre
//     i wallet che agent42 sorveglia, non tutti i partecipanti.
// Dove il dato manca, questo script scrive «non misurabile» invece di stimare.
//
// Uso: node scripts/analisi-concorrenti.js [--piano <file>] [--giorni 5]

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RADICE = path.join(__dirname, '..');
const RS = require(path.join(RADICE, 'lib', 'rewardScore.js'));
const { raggioBandaCents } = require('../lib/banda-premiante');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PIANO = arg('--piano', '/tmp/claude-0/-root-rewards-bot/ef771b3e-673a-4dc5-8ef8-b35ba59b0e7a/scratchpad/piano.json');
const GIORNI = Number(arg('--giorni', '5'));

const piano = JSON.parse(fs.readFileSync(PIANO, 'utf8'));
const righe = piano.rows || [];
const perId = new Map(righe.map((r) => [String(r.marketId).toLowerCase(), r]));
const ids = new Set(perId.keys());

// ── 1 · LE RIGHE DI STORICO DEI NOSTRI MERCATI ───────────────────────────────────────────────────
function giorniDaLeggere(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const f = path.join(RADICE, 'data', `mid-history-${d}.jsonl`);
    if (fs.existsSync(f)) out.push({ giorno: d, file: f });
  }
  return out.reverse();
}

async function leggiStorico() {
  const perMercato = new Map([...ids].map((id) => [id, []]));
  for (const { file } of giorniDaLeggere(GIORNI)) {
    await new Promise((res) => {
      const rl = readline.createInterface({ input: fs.createReadStream(file) });
      rl.on('line', (l) => {
        // Filtro a stringa PRIMA di parsare: su file da 100 MB il JSON.parse di ogni riga costa più
        // di tutto il resto messo insieme.
        if (l.length < 40) return;
        let ok = false;
        for (const id of ids) { if (l.includes(id.slice(2, 26))) { ok = true; break; } }
        if (!ok) return;
        let j; try { j = JSON.parse(l); } catch { return; }
        const k = String(j.marketId || '').toLowerCase();
        if (!perMercato.has(k)) return;
        perMercato.get(k).push(j);
      });
      rl.on('close', res);
    });
  }
  for (const a of perMercato.values()) a.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  return perMercato;
}

// ── 2 · I LIVELLI DENTRO LA BANDA, da una riga di storico ────────────────────────────────────────
function livelliInBanda(r) {
  const out = { bid: [], ask: [] };
  if (!r || !Array.isArray(r.levels)) return out;
  const lo = Number(r.bandLow); const hi = Number(r.bandHigh); const mid = Number(r.adjMid ?? r.plainMid);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(mid)) return out;
  for (const L of r.levels) {
    const bp = Number(L.bidPrice); const bs = Number(L.bidSizeAtLevel);
    if (Number.isFinite(bp) && Number.isFinite(bs) && bs > 0 && bp >= lo && bp <= hi) {
      out.bid.push({ prezzo: bp, size: bs, distanzaC: +((mid - bp) * 100).toFixed(2) });
    }
    const ap = Number(L.askPrice); const as_ = Number(L.askSizeAtLevel);
    if (Number.isFinite(ap) && Number.isFinite(as_) && as_ > 0 && ap >= lo && ap <= hi) {
      out.ask.push({ prezzo: ap, size: as_, distanzaC: +((ap - mid) * 100).toFixed(2) });
    }
  }
  out.bid.sort((a, b) => b.prezzo - a.prezzo);
  out.ask.sort((a, b) => a.prezzo - b.prezzo);
  return out;
}

// ── 3 · LA CONCORRENZA IN BANDA CON LA FORMULA DEL VENUE ─────────────────────────────────────────
// Non si «recupera» Q dai livelli pubblicati: si CALCOLA sulla scala vera, con la stessa
// `scoreOrder` del repo, che è la S(v,s) del venue. Più diretto e senza inversioni.
function qConcorrenti(liv, mid, maxSpreadCents) {
  const v = raggioBandaCents(maxSpreadCents);
  const somma = (lato) => lato.reduce((s, x) => s + RS.scoreOrder(Math.max(0, x.distanzaC), v) * x.size, 0);
  const qb = somma(liv.bid); const qa = somma(liv.ask);
  return { qBid: qb, qAsk: qa, q: RS.qMin(qb, qa, mid) };
}

function nostroQ(prezzoBid, prezzoAsk, shares, mid, maxSpreadCents) {
  const v = raggioBandaCents(maxSpreadCents);
  const dB = Math.max(0, (mid - prezzoBid) * 100);
  const dA = Math.max(0, (prezzoAsk - mid) * 100);
  const qb = RS.scoreOrder(dB, v) * shares;
  const qa = RS.scoreOrder(dA, v) * shares;
  return RS.qMin(qb, qa, mid);
}

// ── 4 · PERSISTENZA DI UN LIVELLO ────────────────────────────────────────────────────────────────
// ⚠ MISURA LA PERSISTENZA DI UN PREZZO, NON LA VITA DI UN ORDINE. Il book è aggregato: un prezzo che
// resta occupato per sei ore può essere lo stesso ordine o dodici ordini che si danno il cambio. È un
// LIMITE SUPERIORE alla vita di un ordine, e va letto così.
function persistenza(righeStoriche) {
  const vivo = new Map();          // "lato|prezzo" → ts di inizio
  const durate = [];
  const troncate = [];             // ancora vive a fine finestra: NON sono durate osservate
  let precedenteTs = null;
  const BUCO_MAX_MS = 20 * 60_000; // oltre venti minuti di silenzio non si presume continuità
  for (const r of righeStoriche) {
    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts)) continue;
    if (precedenteTs != null && ts - precedenteTs > BUCO_MAX_MS) {
      for (const [, inizio] of vivo) durate.push(ts - inizio);
      vivo.clear();
    }
    const liv = livelliInBanda(r);
    const presenti = new Set();
    for (const lato of ['bid', 'ask']) {
      for (const x of liv[lato]) presenti.add(`${lato}|${x.prezzo}`);
    }
    for (const k of presenti) if (!vivo.has(k)) vivo.set(k, ts);
    for (const [k, inizio] of [...vivo]) {
      if (!presenti.has(k)) { durate.push(ts - inizio); vivo.delete(k); }
    }
    precedenteTs = ts;
  }
  // ⚠ CENSURA A DESTRA: un livello ancora presente all'ultimo campione non ha una durata OSSERVATA —
  // ha una durata ALMENO di tanto. Metterlo insieme alle altre abbassa la mediana e fa sembrare gli
  // ordini piu' effimeri di quanto siano. Si tengono separate e si dichiarano.
  for (const [, inizio] of vivo) if (precedenteTs != null) troncate.push(precedenteTs - inizio);
  return {
    complete: durate.filter((d) => d > 0).sort((a, b) => a - b),
    troncate: troncate.filter((d) => d > 0).sort((a, b) => a - b),
  };
}

// OCCUPAZIONE DELLA BANDA e BILANCIAMENTO: due misure che il book aggregato PUO' dare, a differenza
// del conteggio dei partecipanti. «Entrambi i lati occupati» e «size comparabili fra i lati» sono la
// firma strutturale del market making a due lati; una banda occupata da un lato solo, o con un lato
// venti volte l'altro, e' la firma di chi sta prendendo una direzione.
function strutturaBanda(righeStoriche) {
  let n = 0; let dueLati = 0; let unLato = 0; let vuota = 0;
  const rapporti = [];
  for (const r of righeStoriche) {
    const liv = livelliInBanda(r);
    const b = liv.bid.reduce((s, x) => s + x.size, 0);
    const a = liv.ask.reduce((s, x) => s + x.size, 0);
    n += 1;
    if (b > 0 && a > 0) { dueLati += 1; rapporti.push(Math.min(b, a) / Math.max(b, a)); }
    else if (b > 0 || a > 0) unLato += 1;
    else vuota += 1;
  }
  rapporti.sort((x, y) => x - y);
  return { campioni: n, dueLatiFrac: n ? +(dueLati / n).toFixed(3) : null,
    unLatoFrac: n ? +(unLato / n).toFixed(3) : null, vuotaFrac: n ? +(vuota / n).toFixed(3) : null,
    rapportoMediano: rapporti.length ? +rapporti[Math.floor(rapporti.length / 2)].toFixed(3) : null };
}

const perc = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const ore = (ms) => (ms == null ? null : +(ms / 3_600_000).toFixed(2));

// ── 5 · I WALLET: L'UNICA FONTE CON IDENTITÀ ─────────────────────────────────────────────────────
// E il FILTRO MARKET MAKER, dichiarato per esteso nel documento. Su questi dati un wallet è
// classificabile solo per ciò che gli eventi mostrano: ingressi, ritiri, e se il ritiro avviene prima
// della risoluzione. La presenza SIMULTANEA sui due lati non è nei dati (l'evento non porta il lato),
// quindi il criterio del rapporto fra le size dei due lati NON è applicabile e viene dichiarato tale.
function wallets() {
  const perWallet = new Map();
  for (const l of fs.readFileSync(path.join(RADICE, 'data', 'maker-21-eventi.jsonl'), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const w = j.wallet; if (!w) continue;
    if (!perWallet.has(w)) perWallet.set(w, { wallet: w, nome: j.nome || null, ingressi: 0, ritiri: 0, mercati: new Set(), nostri: new Set(), ritiriPrimaDellaRisoluzione: 0 });
    const p = perWallet.get(w);
    if (j.tipo === 'ingresso') p.ingressi += 1;
    if (j.tipo === 'ritiro') {
      p.ritiri += 1;
      if (Number.isFinite(j.orePrimaDellaRisoluzione) && j.orePrimaDellaRisoluzione > 0) p.ritiriPrimaDellaRisoluzione += 1;
    }
    const cid = String(j.conditionId || '').toLowerCase();
    if (cid) { p.mercati.add(cid); if (ids.has(cid)) p.nostri.add(cid); }
  }
  return [...perWallet.values()];
}

// ── 6 · I TRADE PUBBLICI: L'UNICA FONTE CON IDENTITA' SU QUESTI MERCATI ─────────────────────────
//
// `GET data-api.polymarket.com/trades?market=<conditionId>` e' pubblico, senza credenziali, e porta
// `proxyWallet`, `side`, `asset` (il token, cioe' il LATO del mercato binario) e `size`.
//
// ⚠ IL LIMITE, CHE E' GROSSO E VA LETTO PRIMA DEI NUMERI: i trade dicono chi ESEGUE, non chi QUOTA.
// Un market maker i cui ordini non vengono mai colpiti non compare qui — ed e' proprio il maker piu'
// bravo. Quindi questi conteggi sono un LIMITE INFERIORE dei partecipanti, e vanno letti come «chi si
// e' visto muovere», non «chi c'e' nel book».
async function tradePerMercato(id, limite = 500) {
  try {
    const r = await fetch(`https://data-api.polymarket.com/trades?market=${id}&limit=${limite}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { ok: false, motivo: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, trade: Array.isArray(j) ? j : (j.data || []) };
  } catch (e) { return { ok: false, motivo: e.message }; }
}

// ── IL FILTRO MARKET MAKER, DICHIARATO ───────────────────────────────────────────────────────────
// Un wallet conta come MARKET MAKER VERO su un mercato se, sui trade osservati:
//   1. compare su ENTRAMBI i token del mercato binario (o comunque sia in BUY sia in SELL) —
//      la presenza a due lati e' il requisito minimo, e da sola non basta;
//   2. le size dei due lati sono COMPARABILI: min/max >= 0.33, cioe' il lato piccolo vale almeno un
//      terzo del grande. Sotto quella soglia una gamba e' un accessorio dell'altra, non una quota;
//   3. ha almeno una VENDITA, cioe' chiude esposizione invece di accumularla soltanto.
// Chi non passa tutti e tre e' classificato DIREZIONALE ed escluso dal conteggio dei concorrenti
// rilevanti. La soglia 0,33 e' una scelta: e' il punto in cui un lato e' ancora una quota e non un
// residuo, ed e' dichiarata qui perche' cambiandola cambiano i numeri.
function classificaWallet(trade) {
  const per = new Map();
  for (const t of trade) {
    const w = t.proxyWallet; if (!w) continue;
    const size = Number(t.size) || 0;
    if (!per.has(w)) per.set(w, { wallet: w, nome: t.name || t.pseudonym || null, buy: 0, sell: 0, perAsset: new Map(), trade: 0, volume: 0 });
    const p = per.get(w);
    p.trade += 1; p.volume += size;
    if (String(t.side).toUpperCase() === 'SELL') p.sell += size; else p.buy += size;
    const a = String(t.asset || '');
    p.perAsset.set(a, (p.perAsset.get(a) || 0) + size);
  }
  const out = [];
  for (const p of per.values()) {
    const perAsset = [...p.perAsset.values()].sort((a, b) => b - a);
    const dueToken = p.perAsset.size >= 2;
    const dueLati = p.buy > 0 && p.sell > 0;
    const rapportoToken = perAsset.length >= 2 ? perAsset[1] / perAsset[0] : 0;
    const rapportoLati = Math.min(p.buy, p.sell) / Math.max(p.buy, p.sell || 1);
    const rapporto = Math.max(rapportoToken, dueLati ? rapportoLati : 0);
    const chiude = p.sell > 0;
    const mm = (dueToken || dueLati) && rapporto >= 0.33 && chiude;
    out.push({ wallet: p.wallet, nome: p.nome, trade: p.trade, volume: +p.volume.toFixed(1),
      buy: +p.buy.toFixed(1), sell: +p.sell.toFixed(1), token: p.perAsset.size,
      rapporto: +rapporto.toFixed(3), mm,
      motivo: mm ? 'due lati + size comparabili + chiude' : (!chiude ? 'non vende mai: accumula' : (!(dueToken || dueLati) ? 'un lato solo' : `size sbilanciate (${rapporto.toFixed(2)} < 0.33)`)) });
  }
  return out.sort((a, b) => b.volume - a.volume);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  const storico = await leggiStorico();
  const W = wallets();
  const out = [];

  for (const [id, riga] of perId) {
    const rows = storico.get(id) || [];
    const ultima = rows.length ? rows[rows.length - 1] : null;
    const liv = livelliInBanda(ultima);
    const mid = ultima ? Number(ultima.adjMid ?? ultima.plainMid) : Number(riga.mid);
    const banda = Number(riga.maxSpreadCents);
    const tick = Number(riga.tick);
    const q = ultima ? qConcorrenti(liv, mid, banda) : null;
    const shares = Number(riga.sizePerSideShares) || 0;
    const nq = ultima ? nostroQ(Number(riga.snappedBid), Number(riga.snappedAsk), shares, mid, banda) : null;
    const quota = (q && nq != null && (nq + q.q) > 0) ? nq / (nq + q.q) : null;

    // Dove stiamo rispetto a loro, e la regola «mai primo».
    const migliorBid = liv.bid.length ? liv.bid[0].prezzo : null;
    const migliorAsk = liv.ask.length ? liv.ask[0].prezzo : null;
    const unTickDietroBid = migliorBid != null ? +(migliorBid - tick).toFixed(6) : null;
    const unTickDietroAsk = migliorAsk != null ? +(migliorAsk + tick).toFixed(6) : null;
    const lo = ultima ? Number(ultima.bandLow) : null;
    const hi = ultima ? Number(ultima.bandHigh) : null;
    const rinunciaBid = (unTickDietroBid != null && lo != null) ? unTickDietroBid < lo : null;
    const rinunciaAsk = (unTickDietroAsk != null && hi != null) ? unTickDietroAsk > hi : null;

    const dur = persistenza(rows);
    const strut = strutturaBanda(rows);
    const tr = await tradePerMercato(id);
    const wl = tr.ok ? classificaWallet(tr.trade) : [];
    out.push({
      id, nome: riga.name || riga.shortId || id.slice(0, 12),
      capitale: riga.capital, shares, nostroBid: riga.snappedBid, nostroAsk: riga.snappedAsk,
      tick, banda, mid, lo, hi,
      campioni: rows.length,
      primoTs: rows.length ? rows[0].ts : null, ultimoTs: ultima ? ultima.ts : null,
      livelliBid: liv.bid.length, livelliAsk: liv.ask.length,
      sizeBid: +liv.bid.reduce((s, x) => s + x.size, 0).toFixed(1),
      sizeAsk: +liv.ask.reduce((s, x) => s + x.size, 0).toFixed(1),
      distribBid: liv.bid.map((x) => ({ d: x.distanzaC, size: +x.size.toFixed(1) })),
      distribAsk: liv.ask.map((x) => ({ d: x.distanzaC, size: +x.size.toFixed(1) })),
      migliorBid, migliorAsk, rinunciaBid, rinunciaAsk,
      qConc: q ? +q.q.toFixed(2) : null, qNostro: nq != null ? +nq.toFixed(2) : null,
      quotaNostra: quota != null ? +(quota * 100).toFixed(2) : null,
      poolGiorno: Number(riga.rif && riga.rif.dailyPool) || null,
      nettoStimato: riga.netPerDay ?? null,
      persistenzaN: dur.complete.length,
      persistenzaMediana: ore(perc(dur.complete, 0.5)), persistenzaP90: ore(perc(dur.complete, 0.9)),
      persistenzaMax: ore(dur.complete[dur.complete.length - 1]),
      troncateN: dur.troncate.length, troncateMediana: ore(perc(dur.troncate, 0.5)),
      struttura: strut,
      tradeOk: tr.ok, tradeMotivo: tr.ok ? null : tr.motivo, tradeN: tr.ok ? tr.trade.length : 0,
      walletTotali: wl.length, walletMM: wl.filter((w) => w.mm).length,
      wallet: wl.slice(0, 25),
    });
  }

  const wNostri = W.filter((w) => w.nostri.size > 0)
    .map((w) => ({ ...w, mercati: w.mercati.size, nostri: w.nostri.size,
      fraseRitiro: w.ritiri > 0 ? +(w.ritiriPrimaDellaRisoluzione / w.ritiri).toFixed(2) : null }))
    .sort((a, b) => b.nostri - a.nostri || b.ingressi - a.ingressi);

  fs.writeFileSync(path.join(RADICE, 'docs', 'analisi-concorrenti-dati.json'),
    JSON.stringify({ generatoIso: new Date().toISOString(), pianoAt: piano.generatedAt, giorniStorico: GIORNI, mercati: out, walletSuiNostriMercati: wNostri }, null, 1));

  // ── stampa sintetica ───────────────────────────────────────────────────────────────────────────
  console.log(`\nMERCATI: ${out.length} · storico ${GIORNI} giorni\n`);
  console.log('mercato'.padEnd(34), 'liv.B/A', 'sizeB/A'.padStart(16), 'nostraQuota'.padStart(12), 'persist.mediana'.padStart(16), 'campioni'.padStart(9));
  for (const m of out) {
    console.log(
      m.nome.slice(0, 33).padEnd(34),
      `${m.livelliBid}/${m.livelliAsk}`.padEnd(8),
      `${m.sizeBid}/${m.sizeAsk}`.padStart(16),
      (m.quotaNostra != null ? m.quotaNostra + '%' : 'n/d').padStart(12),
      (m.persistenzaMediana != null ? m.persistenzaMediana + 'h' : 'n/d').padStart(16),
      String(m.campioni).padStart(9));
  }
  console.log(`\nWALLET identificabili sui nostri mercati: ${wNostri.length}`);
  for (const w of wNostri.slice(0, 12)) {
    console.log(`  ${w.wallet.slice(0, 12)}… ${(w.nome || '').slice(0, 18).padEnd(19)} nostri ${w.nostri}/${out.length} · mercati totali ${w.mercati} · ingressi ${w.ingressi} · ritiri ${w.ritiri} (pre-risoluzione ${w.fraseRitiro ?? 'n/d'})`);
  }
  console.log('\ndati completi in docs/analisi-concorrenti-dati.json\n');
})();

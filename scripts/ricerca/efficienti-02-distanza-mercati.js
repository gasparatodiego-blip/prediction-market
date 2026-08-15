'use strict';
// scripts/ricerca/efficienti-02-distanza-mercati.js — DOVE QUOTANO GLI EFFICIENTI. Sola lettura.
//
//   node scripts/ricerca/efficienti-02-distanza-mercati.js [--giorni 7] [--max-fill 300]
//
// Risponde a due delle tre domande dell'operatore sul gruppo di `efficienti-01-gruppo.json`:
//   ① a che DISTANZA DAL MID stavano quotando, ricostruita dai loro ordini eseguiti;
//   ② quali MERCATI quotano, con quale `minSize` e `maxSpread`.
// La terza (uscita dopo il fill) è già in `screening-05-uscite.json`.
//
// ═══ ① LA DISTANZA: COSA SI PUÒ E COSA NON SI PUÒ RICOSTRUIRE ════════════════════════════════════
// Un fill non porta con sé il mid. Il mid storico si prende da `clob.polymarket.com/prices-history`
// (pubblico, senza credenziali) a `fidelity=1`, che restituisce un campione ogni ~60 s.
//
// ⚠ LA TRAPPOLA, e va misurata invece che assunta: se quella serie fosse il PREZZO DELL'ULTIMO
// SCAMBIO invece del punto medio, il campione all'istante del fill varrebbe il prezzo del fill e la
// distanza uscirebbe zero **per costruzione**. Due difese:
//   · si usa il campione STRETTAMENTE PRECEDENTE il fill (`t < ts`), cioè il mid prima che l'ordine
//     a riposo venisse colpito — che è anche la domanda giusta: «dove stava, rispetto al mid, mentre
//     aspettava»;
//   · si misura la SEMANTICA e si stampa: quota di fill in cui il campione successivo coincide
//     esattamente col prezzo del fill. Vicina a 1 ⇒ è una serie di ultimi scambi e la misura del
//     campione «dopo» va buttata; bassa ⇒ è un punto medio.
// Se il campione precedente dista più di `MAX_ETA_MID_S` dal fill, la riga è **non misurata**: un
// mid di dieci minuti prima non descrive dove stava l'ordine.
//
// ⚠ SOLO I FILL MAKER. Un fill taker è un ordine che ha attraversato lo spread: la sua «distanza dal
// mid» è il costo di esecuzione, non la posizione di quotazione. L'etichetta maker/taker si ottiene
// per differenza fra `/trades?takerOnly=false` e `takerOnly=true`, con la stessa cintura di
// `screening-05-uscite.js`: si classifica solo l'intervallo coperto da ENTRAMBE le liste.
//
// ═══ ② I MERCATI ═════════════════════════════════════════════════════════════════════════════════
// L'insieme dei mercati viene dallo STESSO campione di trade della domanda ①, non dalle posizioni:
// una coppia completa si fonde o si riscatta e sparisce da `/positions` (§5-bis p.150), quindi le
// posizioni sottostimano proprio chi appaia bene. `minSize` e `maxSpread` da Gamma.
//
// ⚠ IL CAMPIONE È A NUMERO FISSO DI PAGINE, quindi copre archi diversi per wallet: un wallet veloce
// vede meno ore di uno lento. La copertura in ore è riportata wallet per wallet e va letta accanto a
// ogni numero — è lo stesso limite dichiarato in §5-bis p.161.

const { apiGet, inParallelo, scrivi, leggi, mediana } = require('./screening-lib');

const argomenti = process.argv.slice(2);
const arg = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? Number(argomenti[i + 1]) : difetto;
};
const GIORNI = arg('--giorni', 7);
/** Quanti fill maker per wallet si portano a misura del mid. Campionamento uniforme, dichiarato. */
const MAX_FILL_PER_WALLET = arg('--max-fill', 300);
const PER_PAGINA = 500;
const PAGINE_MAX = 12;
/** Oltre questa età il campione di mid non descrive più l'istante del fill. */
const MAX_ETA_MID_S = 180;
/** Due righe con stesso lato/esito/prezzo entro questo intervallo sono lo stesso ordine (come in 05). */
const FINESTRA_UNIONE_S = 120;

const chiave = (t) => [t.conditionId, t.asset, t.timestamp, t.price, t.size, t.side].join('|');

async function scarica(wallet, soloTaker, daTs) {
  const righe = new Map();
  let piuVecchio = Infinity;
  let pagine = 0;
  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const r = await apiGet(`/trades?user=${wallet}&takerOnly=${soloTaker}&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista' };
    pagine += 1;
    for (const t of r.dati) {
      righe.set(chiave(t), t);
      if (t.timestamp < piuVecchio) piuVecchio = t.timestamp;
    }
    if (r.dati.length < PER_PAGINA) break;
    if (piuVecchio <= daTs) break;
  }
  return { ok: true, righe: [...righe.values()], piuVecchio, pagine };
}

/** Fonde i fill parziali dello stesso ordine (stessa regola di 05). */
function unisciParziali(trades) {
  const ord = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const fuori = [];
  for (const t of ord) {
    const u = fuori[fuori.length - 1];
    if (u && u.asset === t.asset && u.side === t.side && u.price === t.price
      && (t.timestamp - u.ultimoTs) <= FINESTRA_UNIONE_S) {
      u.size += Number(t.size); u.ultimoTs = t.timestamp; u.pezzi += 1; u.taker = u.taker || t.taker;
      continue;
    }
    fuori.push({
      conditionId: t.conditionId, asset: t.asset, side: t.side, price: Number(t.price),
      size: Number(t.size), timestamp: t.timestamp, ultimoTs: t.timestamp, pezzi: 1,
      taker: t.taker === true, title: t.title || '', slug: t.slug || '',
    });
  }
  return fuori;
}

// ── LA CACHE DELLE SERIE DI MID ──────────────────────────────────────────────────────────────────
// Chiave `asset|giorno`: un giorno UTC alla volta, così una finestra lunga non diventa una risposta
// troncata di cui non ci si accorge. Condivisa fra tutti i wallet: i mercati si sovrappongono.
const serie = new Map();
const GIORNO_S = 86_400;

async function serieDi(asset, giorno) {
  const k = `${asset}|${giorno}`;
  if (serie.has(k)) return serie.get(k);
  const da = giorno * GIORNO_S - MAX_ETA_MID_S;
  const a = (giorno + 1) * GIORNO_S + MAX_ETA_MID_S;
  const r = await apiGet(`/prices-history?market=${asset}&startTs=${da}&endTs=${a}&fidelity=1`, 0, 'clob.polymarket.com');
  const punti = (r.ok && r.dati && Array.isArray(r.dati.history))
    ? r.dati.history.map((p) => ({ t: Number(p.t), p: Number(p.p) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p)).sort((x, y) => x.t - y.t)
    : null;   // ⚠ null = NON LETTO. Mai [] , o «nessun campione» diventerebbe «mid assente».
  serie.set(k, punti);
  return punti;
}

/** Il campione immediatamente PRIMA e quello immediatamente DOPO `ts`. */
function attorno(punti, ts) {
  if (!punti || !punti.length) return { prima: null, dopo: null };
  let prima = null;
  let dopo = null;
  for (const p of punti) {
    if (p.t < ts) prima = p;
    else { dopo = p; break; }
  }
  return { prima, dopo };
}

async function main() {
  const sel = leggi('efficienti-01-gruppo.json');
  const gruppo = sel.gruppo.map((r) => r.wallet);
  const sensibilita = sel.gruppoSensibilita.map((r) => r.wallet);
  const top5 = sel.top5.map((r) => r.wallet);
  const bersagli = [...new Set([...gruppo, ...sensibilita, ...top5])];
  const etichetta = (w) => (gruppo.includes(w) ? 'efficiente' : (top5.includes(w) ? 'top5' : 'sensibilita'));

  const daTs = Math.floor(Date.now() / 1000) - GIORNI * GIORNO_S;
  console.log(`${bersagli.length} wallet (${gruppo.length} efficienti · ${top5.length} top5 · resto sensibilità) · finestra ${GIORNI}g`);

  // ── PASSO 1: i trade ───────────────────────────────────────────────────────────────────────────
  const scaricati = await inParallelo(bersagli, 4, async (wallet) => {
    const [tutti, taker] = await Promise.all([scarica(wallet, false, daTs), scarica(wallet, true, daTs)]);
    if (!tutti.ok || !taker.ok) return { wallet, ok: false, errore: (tutti.errore || taker.errore) };
    const insiemeTaker = new Set(taker.righe.map(chiave));
    const inizio = Math.max(tutti.piuVecchio, taker.piuVecchio);
    const usabili = tutti.righe.filter((t) => t.timestamp >= inizio).map((t) => ({ ...t, taker: insiemeTaker.has(chiave(t)) }));
    if (!usabili.length) return { wallet, ok: false, errore: 'nessun trade nella finestra comune' };
    const eventi = unisciParziali(usabili);
    const tMax = Math.max(...usabili.map((t) => t.timestamp));
    return {
      wallet, ok: true, etichetta: etichetta(wallet),
      copertura: { da: new Date(inizio * 1000).toISOString(), a: new Date(tMax * 1000).toISOString(), ore: (tMax - inizio) / 3600 },
      pagine: tutti.pagine,
      eventi,
    };
  }, (f, t) => console.log(`  trade … ${f}/${t}`));

  const buoni = scaricati.filter((r) => r && r.ok);
  console.log(`trade letti per ${buoni.length}/${bersagli.length} wallet`);

  // ── PASSO 2: la distanza dal mid, sui soli fill MAKER ──────────────────────────────────────────
  const perWallet = [];
  for (const w of buoni) {
    const maker = w.eventi.filter((e) => !e.taker);
    // Campionamento UNIFORME nel tempo, non «i primi N»: prendere le prime righe prenderebbe solo
    // le ore più recenti, che per un wallet veloce sono un pomeriggio solo.
    const passo = maker.length > MAX_FILL_PER_WALLET ? maker.length / MAX_FILL_PER_WALLET : 1;
    const campione = [];
    for (let i = 0; i < maker.length; i += passo) campione.push(maker[Math.floor(i)]);

    const misure = [];
    let nonMisurati = 0;
    let serieAssenti = 0;
    let coincidenzeDopo = 0;
    let confrontiDopo = 0;
    for (const e of campione) {
      const punti = await serieDi(e.asset, Math.floor(e.timestamp / GIORNO_S));
      if (punti === null) { serieAssenti += 1; nonMisurati += 1; continue; }
      const { prima, dopo } = attorno(punti, e.timestamp);
      if (dopo) { confrontiDopo += 1; if (Math.abs(dopo.p - e.price) < 1e-9) coincidenzeDopo += 1; }
      if (!prima || (e.timestamp - prima.t) > MAX_ETA_MID_S) { nonMisurati += 1; continue; }
      const mid = prima.p;
      const distanzaC = Math.abs(e.price - mid) * 100;
      // Segno: positivo = l'ordine stava dalla parte «giusta» del mid (BUY sotto, SELL sopra).
      const segnata = (e.side === 'BUY' ? (mid - e.price) : (e.price - mid)) * 100;
      misure.push({
        ts: e.timestamp, conditionId: e.conditionId, side: e.side, prezzo: e.price, mid,
        etaMidS: e.timestamp - prima.t, distanzaC, distanzaSegnataC: segnata, size: e.size,
      });
    }

    const d = misure.map((m) => m.distanzaC).sort((a, b) => a - b);
    const q = (f) => (d.length ? d[Math.min(d.length - 1, Math.floor(f * d.length))] : null);
    perWallet.push({
      wallet: w.wallet, etichetta: w.etichetta, copertura: w.copertura, pagine: w.pagine,
      eventiTotali: w.eventi.length,
      eventiMaker: maker.length,
      quotaMaker: w.eventi.length ? maker.length / w.eventi.length : null,
      campionati: campione.length,
      misurati: misure.length,
      nonMisurati,
      serieAssenti,
      semanticaCoincidenzaDopo: confrontiDopo ? coincidenzeDopo / confrontiDopo : null,
      distanzaC: d.length ? { n: d.length, q10: q(0.10), q25: q(0.25), mediana: mediana(d), q75: q(0.75), q90: q(0.90), media: d.reduce((a, b) => a + b, 0) / d.length } : null,
      quotaDallaParteGiusta: misure.length ? misure.filter((m) => m.distanzaSegnataC > 0).length / misure.length : null,
      mercatiDistinti: new Set(w.eventi.map((e) => e.conditionId)).size,
      misure: misure.slice(0, 40),
    });
    console.log(`  mid ${w.wallet.slice(0, 10)} [${w.etichetta}] maker ${maker.length}/${w.eventi.length} · misurati ${misure.length}/${campione.length} · mediana ${d.length ? mediana(d).toFixed(2) + '¢' : 'n/d'}`);
  }

  // ── PASSO 3: i mercati ─────────────────────────────────────────────────────────────────────────
  const perMercato = new Map();
  for (const w of buoni) {
    const visti = new Set();
    for (const e of w.eventi) {
      if (!perMercato.has(e.conditionId)) {
        perMercato.set(e.conditionId, { conditionId: e.conditionId, title: e.title, slug: e.slug, walletEff: new Set(), walletTop: new Set(), walletSens: new Set(), fill: 0 });
      }
      const m = perMercato.get(e.conditionId);
      m.fill += 1;
      if (!visti.has(e.conditionId)) {
        visti.add(e.conditionId);
        if (w.etichetta === 'efficiente') m.walletEff.add(w.wallet);
        else if (w.etichetta === 'top5') m.walletTop.add(w.wallet);
        else m.walletSens.add(w.wallet);
      }
    }
  }
  const mercati = [...perMercato.values()];
  console.log(`\n${mercati.length} mercati distinti nel campione · arricchimento Gamma…`);

  const BLOCCO = 20;
  const ids = mercati.map((m) => m.conditionId);
  for (let i = 0; i < ids.length; i += BLOCCO) {
    const qs = ids.slice(i, i + BLOCCO).map((c) => `condition_ids=${c}`).join('&');
    const r = await apiGet(`/markets?${qs}`, 0, 'gamma-api.polymarket.com');
    if (!r.ok || !Array.isArray(r.dati)) continue;      // assente ≠ zero
    for (const g of r.dati) {
      const m = perMercato.get(String(g.conditionId));
      if (!m) continue;
      m.minSize = Number.isFinite(Number(g.rewardsMinSize)) ? Number(g.rewardsMinSize) : null;
      m.maxSpread = Number.isFinite(Number(g.rewardsMaxSpread)) ? Number(g.rewardsMaxSpread) : null;
      m.volume24h = Number(g.volume24hr);
      m.liquidita = Number(g.liquidity);
      m.endDate = g.endDate || null;
      m.chiuso = g.closed === true;
    }
    if (i % 200 === 0) console.log(`  gamma … ${i}/${ids.length}`);
  }

  const uscita = mercati.map((m) => ({
    conditionId: m.conditionId, title: m.title, slug: m.slug, fill: m.fill,
    efficienti: m.walletEff.size, top5: m.walletTop.size, sensibilita: m.walletSens.size,
    minSize: m.minSize ?? null, maxSpread: m.maxSpread ?? null,
    volume24h: m.volume24h ?? null, liquidita: m.liquidita ?? null, endDate: m.endDate ?? null, chiuso: m.chiuso ?? null,
  }));

  const out = {
    generatoIl: new Date().toISOString(),
    parametri: { giorni: GIORNI, maxFillPerWallet: MAX_FILL_PER_WALLET, maxEtaMidS: MAX_ETA_MID_S, pagineMax: PAGINE_MAX, fidelity: 1 },
    fonti: ['data-api.polymarket.com/trades', 'clob.polymarket.com/prices-history', 'gamma-api.polymarket.com/markets'],
    gruppi: { efficienti: gruppo, top5, sensibilita },
    walletFalliti: scaricati.filter((r) => r && !r.ok),
    perWallet,
    mercati: uscita,
  };
  console.log(`\nscritto ${scrivi('efficienti-02-distanza-mercati.json', out)}`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });

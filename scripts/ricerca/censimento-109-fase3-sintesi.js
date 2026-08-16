#!/usr/bin/env node
'use strict';
// scripts/ricerca/censimento-109-fase3-sintesi.js — LE QUATTRO DOMANDE SUL CENSIMENTO. Sola lettura.
//
//   node scripts/ricerca/censimento-109-fase3-sintesi.js
//
// Non tocca rete tranne il §4, dove i 7 wallet falliti vanno interrogati per sapere PERCHE' sono
// falliti: «nessun trade nella finestra comune» e' un sintomo, non una causa.
//
// ⚠ L'AMMISSIBILITA' NON VIENE RISCRITTA QUI. Si importa `valutaAmmissibilita` da
// `lib/maker/selezione-mercati.js`, che e' pura e i cui quattro vincoli sono la verita' operativa
// (§4.13). Riscrivere «minSize <= 20 e scadenza >= 48 h» in questo file sarebbe il reperto D1, e la
// copia divergerebbe il giorno in cui l'operatore muove una manopola.
// Lo scenario «minSize 50» non puo' invece passare dalla funzione vera — `MIN_SIZE_MASSIMA` e' una
// costante di modulo — quindi si DERIVA dal suo verdetto: sono i mercati che oggi escono con motivo
// `minsize-oltre-soglia` e hanno `rewardsMinSize <= 50`. Cosi' l'unico giudizio resta quello del
// modulo, e la controfattuale e' una selezione sui suoi motivi, non una seconda aritmetica.

const { leggi, mediana, apiGet, scrivi, inParallelo } = require('./screening-lib');
const { valutaAmmissibilita } = require('../../lib/maker/selezione-mercati');
const fs = require('fs');
const path = require('path');

const fin = (x) => Number.isFinite(x);
const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const usd = (n, d = 2) => (fin(n) ? '$' + n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }) : 'n/d');
const pct = (n, d = 1) => (fin(n) ? (n * 100).toFixed(d) + '%' : 'n/d');

function quantile(xs, q) {
  const s = xs.filter(fin).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function riassunto(xs) {
  const s = xs.filter(fin);
  if (!s.length) return null;
  return { n: s.length, q25: quantile(s, 0.25), mediana: mediana(s), q75: quantile(s, 0.75), max: Math.max(...s) };
}

/** Le quote A/B/C/D/E aggregate su un gruppo: si sommano gli EVENTI, non si media la media dei wallet.
 *  Mediare le quote darebbe lo stesso peso a chi ha 12 eventi e a chi ne ha 3.386. */
function usciteAggregate(righe) {
  const t = { A: 0, B: 0, C: 0, D: 0, E: 0, classificati: 0, censurati: 0 };
  for (const r of righe) {
    const u = r.uscite || {};
    for (const k of ['A', 'B', 'C', 'D', 'E']) t[k] += Number(u[k]) || 0;
    t.classificati += Number(u.classificati) || 0;
    t.censurati += Number(u.censurati) || 0;
  }
  const q = {};
  for (const k of ['A', 'B', 'C', 'D', 'E']) q[k] = t.classificati ? t[k] / t.classificati : null;
  return { conteggi: t, quote: q };
}

function boardPerCid() {
  const b = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'liquidity-rewards.json'), 'utf8'));
  const m = new Map();
  for (const r of (b.markets || [])) {
    const cid = normId(r.conditionId);
    if (cid) m.set(cid, r);
  }
  return m;
}

async function principale() {
  const j = leggi('censimento-109-fase2.json');
  const f1 = leggi('censimento-109-fase1.json');
  const righe = (j.perWallet || []).filter((r) => r && r.ok);
  const mercatiDi = new Map((f1.wallet || []).map((r) => [normId(r.wallet), (r.mercatiElenco || []).map(normId)]));
  const board = boardPerCid();
  const ora = Date.now();
  const out = { generatoIl: new Date(ora).toISOString(), fonte: 'censimento-109-fase2.json' };

  console.log('═'.repeat(96));
  console.log(`CENSIMENTO FASE 2 · ${righe.length} wallet profilati su ${j.walletCandidati} · falliti ${j.walletFalliti}`);
  console.log('═'.repeat(96));

  // ══ 1 · REWARDS PER DOLLARO DI CAPITALE ════════════════════════════════════════════════════════
  // ⚠ NUMERATORE E DENOMINATORE NON HANNO LO STESSO TEMPO: i rewards sono 14 giorni, il capitale e'
  // una FOTOGRAFIA di adesso. Un wallet che ha depositato ieri mostra una resa bassa senza demerito, e
  // uno che ha appena prelevato una resa altissima senza merito. Il rapporto ordina, non premia.
  const conCapitale = righe.filter((r) => fin(r.capitaleUsd) && fin(r.rewards14gUsd));
  const PAVIMENTO_CAPITALE = 100;   // sotto, il rapporto esplode e descrive il denominatore, non la resa
  const resa = conCapitale
    .filter((r) => r.capitaleUsd >= PAVIMENTO_CAPITALE)
    .map((r) => ({ ...r, resa: r.rewards14gUsd / r.capitaleUsd }))
    .sort((a, b) => b.resa - a.resa);

  console.log(`\n① RESA — rewards 14g per dollaro di capitale`);
  console.log(`   wallet con capitale e rewards leggibili: ${conCapitale.length}/${righe.length}`);
  console.log(`   esclusi sotto ${usd(PAVIMENTO_CAPITALE, 0)} di capitale: ${conCapitale.length - resa.length}`);
  const rs = riassunto(resa.map((r) => r.resa));
  console.log(`   distribuzione: q25 ${rs.q25.toFixed(4)} · mediana ${rs.mediana.toFixed(4)} · q75 ${rs.q75.toFixed(4)} · max ${rs.max.toFixed(4)}`);
  console.log('\n   #  wallet                                       resa   rewards14g    capitale   merc  dist   A/B/C/D/E');
  for (const [i, r] of resa.slice(0, 20).entries()) {
    const u = r.uscite && r.uscite.quote;
    const abcde = u ? ['A', 'B', 'C', 'D', 'E'].map((k) => (u[k] * 100).toFixed(0)).join('/') : 'n/d';
    console.log(`  ${String(i + 1).padStart(2)}  ${r.wallet}  ${r.resa.toFixed(4).padStart(7)}  `
      + `${usd(r.rewards14gUsd, 0).padStart(10)}  ${usd(r.capitaleUsd, 0).padStart(10)}  `
      + `${String(r.mercatiInsiemeOra ?? '?').padStart(4)}  ${(fin(r.distanzaMidMedianaCents) ? r.distanzaMidMedianaCents.toFixed(2) : ' n/d').padStart(5)}  ${abcde}`);
  }
  // ⚠ LA CLASSIFICA QUI SOPRA E' DOMINATA DAL DENOMINATORE, NON DALLA BRAVURA. Un wallet che ha
  // prelevato mostra una resa enorme, e i primi venti sono quasi tutti B al 90-100%, cioe' gente che
  // compra e rivende — non maker. La seconda classifica chiede una PRESENZA vera (rewards in almeno
  // 10 giorni su 14, lo stesso criterio dello screening) e un capitale non minuscolo: e' la lista che
  // risponde a «chi rende di piu' per dollaro FACENDO liquidity rewards».
  const stabili = conCapitale
    .filter((r) => r.capitaleUsd >= 500 && Number(r.giorniConRewards) >= 10)
    .map((r) => ({ ...r, resa: r.rewards14gUsd / r.capitaleUsd }))
    .sort((a, b) => b.resa - a.resa);
  console.log(`\n   ─ e la stessa classifica fra i PRESENTI (rewards >= 10 giorni su 14, capitale >= $500): ${stabili.length} wallet`);
  const rs2 = riassunto(stabili.map((r) => r.resa));
  if (rs2) console.log(`     distribuzione: q25 ${rs2.q25.toFixed(4)} · mediana ${rs2.mediana.toFixed(4)} · q75 ${rs2.q75.toFixed(4)} · max ${rs2.max.toFixed(4)}`);
  for (const [i, r] of stabili.slice(0, 15).entries()) {
    const u = r.uscite && r.uscite.quote;
    const abcde = u ? ['A', 'B', 'C', 'D', 'E'].map((k) => (u[k] * 100).toFixed(0)).join('/') : 'n/d';
    console.log(`  ${String(i + 1).padStart(2)}  ${r.wallet}  ${r.resa.toFixed(4).padStart(7)}  `
      + `${usd(r.rewards14gUsd, 0).padStart(10)}  ${usd(r.capitaleUsd, 0).padStart(10)}  `
      + `${String(r.mercatiInsiemeOra ?? '?').padStart(4)}  ${(fin(r.distanzaMidMedianaCents) ? r.distanzaMidMedianaCents.toFixed(2) : ' n/d').padStart(5)}  ${abcde}`);
  }

  out.resa = {
    walletConsiderati: resa.length, pavimentoCapitale: PAVIMENTO_CAPITALE, distribuzione: rs,
    presenti: { n: stabili.length, distribuzione: rs2, primi15: stabili.slice(0, 15).map((r) => ({
      wallet: r.wallet, resa: r.resa, rewards14gUsd: r.rewards14gUsd, capitaleUsd: r.capitaleUsd,
      giorniConRewards: r.giorniConRewards, mercatiInsiemeOra: r.mercatiInsiemeOra,
      distanzaMidMedianaCents: r.distanzaMidMedianaCents, quote: r.uscite && r.uscite.quote })) },
    primi20: resa.slice(0, 20).map((r) => ({
      wallet: r.wallet, resa: r.resa, rewards14gUsd: r.rewards14gUsd, capitaleUsd: r.capitaleUsd,
      mercatiInsiemeOra: r.mercatiInsiemeOra, distanzaMidMedianaCents: r.distanzaMidMedianaCents,
      quote: r.uscite && r.uscite.quote,
    })),
  };

  // ══ 2 · IL GRUPPO 5-24 MERCATI INSIEME, CAPITALE $800-$3.000 ═══════════════════════════════════
  // ⚠ «INSIEME» SI LEGGE CON DUE RIGHELLI E SI DICHIARA QUALE: `insiemeOra` e' la fotografia delle
  // posizioni vive adesso (e sparisce quando una coppia si fonde, §5-bis p.150); `insiemeMax` e' il
  // massimo di intervalli sovrapposti nel campione trade, ed e' un limite INFERIORE. Il gruppo si
  // definisce sulla fotografia — e' la lettura piu' vicina a «mercati aperti insieme» — e si riporta
  // quanto cambierebbe con l'altro righello.
  const MIN_M = 5;
  const MAX_M = 24;
  const CAP_MIN = 800;
  const CAP_MAX = 3000;
  const inFascia = (r, campo) => fin(r[campo]) && r[campo] >= MIN_M && r[campo] <= MAX_M
    && fin(r.capitaleUsd) && r.capitaleUsd >= CAP_MIN && r.capitaleUsd <= CAP_MAX;

  const gruppo = righe.filter((r) => inFascia(r, 'mercatiInsiemeOra'));
  const gruppoMax = righe.filter((r) => inFascia(r, 'mercatiInsiemeMax'));

  console.log(`\n② IL GRUPPO — ${MIN_M}-${MAX_M} mercati insieme · capitale ${usd(CAP_MIN, 0)}-${usd(CAP_MAX, 0)}`);
  console.log(`   con il righello «posizioni ora»  : ${gruppo.length} wallet`);
  console.log(`   con il righello «max sovrapposti»: ${gruppoMax.length} wallet  (${righe.filter((r) => inFascia(r, 'mercatiInsiemeOra') && inFascia(r, 'mercatiInsiemeMax')).length} in entrambi)`);

  const g = {
    rewardsGiorno: riassunto(gruppo.map((r) => (fin(r.rewards14gUsd) ? r.rewards14gUsd / 14 : NaN))),
    capitale: riassunto(gruppo.map((r) => r.capitaleUsd)),
    distanza: riassunto(gruppo.map((r) => r.distanzaMidMedianaCents)),
    mercatiOra: riassunto(gruppo.map((r) => r.mercatiInsiemeOra)),
    mercatiCensiti: riassunto(gruppo.map((r) => r.mercatiCensiti)),
    capitalePerMercato: riassunto(gruppo.map((r) => r.capitalePerMercatoUsd)),
    liquiditaBanda: riassunto(gruppo.map((r) => r.liquiditaBandaMedianaUsd)),
    quotaTaker: riassunto(gruppo.map((r) => r.quotaTaker)),
    pnl7g: riassunto(gruppo.map((r) => r.pnl7gUsd)),
    eta: riassunto(gruppo.map((r) => r.etaGiorni)),
    giorniRewards: riassunto(gruppo.map((r) => r.giorniConRewards)),
  };
  const mostra = (nome, r, f = (x) => x.toFixed(2)) => console.log(
    `   ${nome.padEnd(26)} n ${String(r ? r.n : 0).padStart(3)} · q25 ${r ? f(r.q25).padStart(9) : '  n/d'} · mediana ${r ? f(r.mediana).padStart(9) : '  n/d'} · q75 ${r ? f(r.q75).padStart(9) : '  n/d'}`);
  mostra('rewards al giorno ($)', g.rewardsGiorno);
  mostra('capitale ($)', g.capitale, (x) => Math.round(x).toString());
  mostra('capitale per mercato ($)', g.capitalePerMercato);
  mostra('distanza dal mid (¢)', g.distanza);
  mostra('mercati insieme ora', g.mercatiOra, (x) => x.toFixed(0));
  mostra('mercati censiti (14g)', g.mercatiCensiti, (x) => x.toFixed(0));
  mostra('liquidita in banda ($)', g.liquiditaBanda, (x) => Math.round(x).toString());
  mostra('quota taker', g.quotaTaker, (x) => (x * 100).toFixed(1) + '%');
  mostra('P&L 7g ($)', g.pnl7g);
  mostra('eta in giorni', g.eta, (x) => x.toFixed(0));
  mostra('giorni con rewards /14', g.giorniRewards, (x) => x.toFixed(0));

  const uG = usciteAggregate(gruppo);
  console.log(`   uscite (eventi sommati, n=${uG.conteggi.classificati}, censurati ${uG.conteggi.censurati}):`);
  console.log(`      A completa coppia ${pct(uG.quote.A)} · B rivende ${pct(uG.quote.B)} · C non fa nulla ${pct(uG.quote.C)}`
    + ` · D aumenta ${pct(uG.quote.D)} · E vende l'altro lato ${pct(uG.quote.E)}`);
  const costiA = gruppo.map((r) => r.uscite && r.uscite.costoCoppiaMedianoCents).filter(fin);
  const deltaB = gruppo.map((r) => r.uscite && r.uscite.deltaBMedianoCents).filter(fin);
  console.log(`      costo coppia mediano (mediana delle mediane, n=${costiA.length}): ${costiA.length ? mediana(costiA).toFixed(2) + '¢' : 'n/d'}`);
  console.log(`      delta B mediano       (mediana delle mediane, n=${deltaB.length}): ${deltaB.length ? mediana(deltaB).toFixed(2) + '¢' : 'n/d'}`);

  // ⚠ IL GRUPPO NON E' UN GRUPPO DI MAKER, e va detto prima di leggerne le medie: i 973 vengono dal
  // censimento dei mercati premianti, cioe' da CHI LI HA TOCCATI, non da chi incassa. Dentro la
  // fascia chiesta convivono due popolazioni, e il sottoinsieme che incassa davvero si guarda a parte.
  const gruppoIncassa = gruppo.filter((r) => Number(r.giorniConRewards) >= 10);
  const gruppoZero = gruppo.filter((r) => !Number(r.giorniConRewards));
  console.log(`   ⚠ composizione: ${gruppoIncassa.length} incassano in >=10 giorni su 14 · ${gruppoZero.length} non incassano NIENTE · ${gruppo.length - gruppoIncassa.length - gruppoZero.length} in mezzo`);
  if (gruppoIncassa.length) {
    const ui = usciteAggregate(gruppoIncassa);
    console.log(`   il sottogruppo che incassa (n=${gruppoIncassa.length}):`);
    mostra('     rewards al giorno ($)', riassunto(gruppoIncassa.map((r) => r.rewards14gUsd / 14)));
    mostra('     capitale ($)', riassunto(gruppoIncassa.map((r) => r.capitaleUsd)), (x) => Math.round(x).toString());
    mostra('     distanza dal mid (¢)', riassunto(gruppoIncassa.map((r) => r.distanzaMidMedianaCents)));
    mostra('     mercati insieme ora', riassunto(gruppoIncassa.map((r) => r.mercatiInsiemeOra)), (x) => x.toFixed(0));
    mostra('     quota taker', riassunto(gruppoIncassa.map((r) => r.quotaTaker)), (x) => (x * 100).toFixed(1) + '%');
    console.log(`        uscite (n=${ui.conteggi.classificati}): A ${pct(ui.quote.A)} · B ${pct(ui.quote.B)} · C ${pct(ui.quote.C)} · D ${pct(ui.quote.D)} · E ${pct(ui.quote.E)}`);
    out.gruppoIncassa = { n: gruppoIncassa.length, uscite: ui, wallet: gruppoIncassa.map((r) => r.wallet) };
  }

  // Confronto col resto della popolazione, o «alto/basso» non ha metro.
  const fuori = righe.filter((r) => !gruppo.includes(r));
  const uF = usciteAggregate(fuori);
  console.log(`   confronto col resto (${fuori.length} wallet): A ${pct(uF.quote.A)} · B ${pct(uF.quote.B)} · C ${pct(uF.quote.C)} · D ${pct(uF.quote.D)} · E ${pct(uF.quote.E)}`);

  out.gruppo = {
    filtro: { mercatiMin: MIN_M, mercatiMax: MAX_M, capitaleMin: CAP_MIN, capitaleMax: CAP_MAX },
    nOra: gruppo.length, nMax: gruppoMax.length,
    misure: g, uscite: uG,
    costoCoppiaMedianoCents: costiA.length ? mediana(costiA) : null,
    deltaBMedianoCents: deltaB.length ? mediana(deltaB) : null,
    confrontoResto: uF,
    wallet: gruppo.map((r) => r.wallet),
  };

  // ══ 3 · QUANTI DEI LORO MERCATI IL BOT PUO' SELEZIONARE ════════════════════════════════════════
  const universo = new Map();   // cid → n wallet del gruppo che l'hanno toccato
  for (const r of gruppo) for (const cid of (mercatiDi.get(r.wallet) || [])) universo.set(cid, (universo.get(cid) || 0) + 1);

  const verdetti = [];
  for (const [cid, quanti] of universo) {
    const riga = board.get(cid);
    const v = valutaAmmissibilita(riga, { ora });
    const ms = riga ? Number(riga.rewardsMinSize) : NaN;

    // ⚠ LA CONTROFATTUALE NON SI DEDUCE DAL MOTIVO, O E' UN LIMITE SUPERIORE E BASTA.
    // `valutaAmmissibilita` esce al PRIMO vincolo che fallisce: un mercato bocciato per lo scaglione
    // puo' essere anche meteo, anche in scadenza fra dieci ore, anche senza data — e nessuno di quei
    // difetti si vede, perche' il controllo dello scaglione viene per primo. Contare «minSize <= 50»
    // come «entrerebbe» conterebbe quindi mercati che uscirebbero comunque un rigo dopo.
    // Si rigiudica invece la riga con lo scaglione ABBASSATO A MANO a 20 — la stessa funzione, gli
    // stessi altri tre vincoli, esercitati davvero.
    const clone = riga && fin(ms) && ms <= 50 ? { ...riga, rewardsMinSize: 20 } : null;
    const v50 = clone ? valutaAmmissibilita(clone, { ora }) : null;

    verdetti.push({
      conditionId: cid, quantiWallet: quanti, question: riga ? riga.question : null,
      minSize: fin(ms) ? ms : null, ammissibile: v.ammissibile, motivo: v.motivo,
      oreAllaScadenza: v.oreAllaScadenza !== null ? v.oreAllaScadenza : (v50 ? v50.oreAllaScadenza : null),
      ammissibileConMinSize50: v.ammissibile || Boolean(v50 && v50.ammissibile),
      motivoConMinSize50: v.ammissibile ? 'ammissibile' : (v50 ? v50.motivo : v.motivo),
    });
  }
  const oggi = verdetti.filter((v) => v.ammissibile);
  const con50 = verdetti.filter((v) => v.ammissibileConMinSize50);
  const perMotivo = new Map();
  for (const v of verdetti) if (!v.ammissibile) perMotivo.set(v.motivo, (perMotivo.get(v.motivo) || 0) + 1);

  console.log(`\n③ COSA IL BOT PUO' SELEZIONARE, dei ${universo.size} mercati distinti toccati dal gruppo`);
  console.log(`   vincoli di oggi (minSize <= 20 · >= 48 h · niente meteo) : ${oggi.length}  (${pct(oggi.length / universo.size)})`);
  console.log(`   alzando lo scaglione a minSize <= 50                     : ${con50.length}  (${pct(con50.length / universo.size)})`);
  console.log('   perche' + "' escono gli altri:");
  for (const [m, n] of [...perMotivo].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)} × ${m}`);
  if (oggi.length) {
    console.log('   ammissibili OGGI (per quanti wallet del gruppo li toccano):');
    for (const v of oggi.sort((a, b) => b.quantiWallet - a.quantiWallet).slice(0, 12)) {
      console.log(`      ${String(v.quantiWallet).padStart(3)} wallet · minSize ${String(v.minSize).padStart(4)} · ${fin(v.oreAllaScadenza) ? v.oreAllaScadenza.toFixed(0).padStart(5) : '  n/d'} h · ${String(v.question).slice(0, 60)}`);
    }
  }
  const bocciatiAnche50 = verdetti.filter((v) => !v.ammissibileConMinSize50 && v.motivo === 'minsize-oltre-soglia' && fin(v.minSize) && v.minSize <= 50);
  if (bocciatiAnche50.length) {
    console.log(`   ⚠ ${bocciatiAnche50.length} mercati con minSize <= 50 NON entrerebbero comunque, per un vincolo che oggi non si vede:`);
    const m = new Map();
    for (const v of bocciatiAnche50) m.set(v.motivoConMinSize50, (m.get(v.motivoConMinSize50) || 0) + 1);
    for (const [k, n] of [...m].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)} × ${k}`);
  }
  const nuovi50 = con50.filter((v) => !v.ammissibile);
  if (nuovi50.length) {
    console.log('   sbloccati SOLO dallo scaglione 50:');
    for (const v of nuovi50.sort((a, b) => b.quantiWallet - a.quantiWallet).slice(0, 12)) {
      console.log(`      ${String(v.quantiWallet).padStart(3)} wallet · minSize ${String(v.minSize).padStart(4)} · ${fin(v.oreAllaScadenza) ? v.oreAllaScadenza.toFixed(0).padStart(5) : '  n/d'} h · ${String(v.question).slice(0, 60)}`);
    }
  }
  out.selezionabili = {
    universo: universo.size, ammissibiliOggi: oggi.length, ammissibiliConMinSize50: con50.length,
    perMotivo: [...perMotivo].map(([motivo, n]) => ({ motivo, n })),
    dettaglio: verdetti.sort((a, b) => b.quantiWallet - a.quantiWallet),
  };

  // ══ 4 · I 7 SENZA TRADE ═══════════════════════════════════════════════════════════════════════
  // «nessun trade nella finestra comune» dice DOVE si e' fermato il codice, non perche'. Le cause
  // possibili sono tre e si distinguono con due letture: (a) il wallet non scambia da piu' di 7
  // giorni; (b) `/trades` non lo conosce affatto; (c) tutti i suoi fill sono taker o tutti maker,
  // e una delle due liste e' vuota ⇒ l'intersezione delle finestre e' vuota.
  const falliti = (j.erroriCampione || []).map((x) => x.wallet);
  console.log(`\n④ I ${falliti.length} SENZA TRADE — perche'`);
  const diagnosi = await inParallelo(falliti, 3, async (w) => {
    const [tutti, taker, att] = await Promise.all([
      apiGet(`/trades?user=${w}&takerOnly=false&limit=100`),
      apiGet(`/trades?user=${w}&takerOnly=true&limit=100`),
      apiGet(`/activity?user=${w}&type=TRADE&limit=1`),
    ]);
    const n = (r) => (r.ok && Array.isArray(r.dati) ? r.dati.length : null);
    const ultimo = (r) => (r.ok && Array.isArray(r.dati) && r.dati.length
      ? Math.max(...r.dati.map((t) => Number(t.timestamp)).filter(fin)) : null);
    const f1r = (f1.wallet || []).find((x) => normId(x.wallet) === w);
    const tsT = ultimo(tutti);
    return {
      wallet: w,
      tradesTutti: n(tutti), tradesTaker: n(taker),
      ultimoTradeIso: tsT ? new Date(tsT * 1000).toISOString() : null,
      giorniDaUltimoTrade: tsT ? (ora / 1000 - tsT) / 86400 : null,
      activityTrade: n(att),
      censimento: f1r ? { fill: f1r.fill, mercati: f1r.mercati, ultimoIso: new Date(f1r.ultimo * 1000).toISOString() } : null,
    };
  });
  for (const d of diagnosi) {
    console.log(`   ${d.wallet}`);
    console.log(`      /trades tutti ${d.tradesTutti} · taker ${d.tradesTaker} · /activity ${d.activityTrade}`
      + ` · ultimo trade ${d.ultimoTradeIso || 'n/d'}${fin(d.giorniDaUltimoTrade) ? ` (${d.giorniDaUltimoTrade.toFixed(1)} g fa)` : ''}`);
    if (d.censimento) console.log(`      fase 1 lo aveva visto: ${d.censimento.fill} fill su ${d.censimento.mercati} mercati, ultimo ${d.censimento.ultimoIso}`);
  }
  out.senzaTrade = diagnosi;

  const f = scrivi('censimento-109-fase3-sintesi.json', out);
  console.log(`\nscritto ${f}`);
}

principale().catch((e) => { console.error('GUASTO:', e && e.stack ? e.stack : e); process.exitCode = 1; });

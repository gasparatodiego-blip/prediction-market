'use strict';
// scripts/ricerca/screening-04-referto.js — I FILTRI FINALI, LA TABELLA DEI 20 E LA CLASSIFICA DEI MERCATI.
//
//   node scripts/ricerca/screening-04-referto.js [--due-lati 0.30] [--rapporto-pnl 1.0]
//
// ═══ I QUATTRO FILTRI, E DA DOVE VIENE OGNI SOGLIA ═══════════════════════════════════════════════
//   ① ricorrenza ≥ 10 giorni su 14        — chiesta dall'operatore. Contata su DATE DI PAGAMENTO
//                                            grezze, non su competenza: il 2026-08-14 il venue non ha
//                                            pagato a mezzanotte (giro uscito alle 16:23), e contare
//                                            per competenza punirebbe tutti di un giorno.
//   ② due-lateralità ≥ 30% dei mercati    — misurata sui TRADE, non sulle posizioni (vedi lo stadio 3).
//                                            ⚠ SOGLIA PERCENTILE, NON UN VARCO: la distribuzione è un
//                                            decadimento liscio senza vuoti (mediana 6,7%, q90 31,9%).
//                                            30% è il q90 della popolazione già filtrata, ~5× la
//                                            mediana, e sta molto sopra il 2-6% dei direzionali del
//                                            campione. Il riferimento calibrante è il funder di questo
//                                            bot, maker a due lati NOTO: **52%**.
//   ③ |P&L 7g| ≤ rewards 7g               — la soglia è SEMANTICA, non percentile: «il trading pesa
//                                            meno dei premi» è esattamente il criterio chiesto.
//   ④ mediana giornaliera ≥ $1 e più di
//     un pagamento                        — chiesto dall'operatore, applicato già nello stadio 3.
//
// ⚠ NESSUNO DEI QUATTRO È UNA PROVA DI INTENZIONE. Sono l'impronta pubblica di un comportamento; un
// wallet che quota due lati e chiude in pari è indistinguibile da un market maker che fa altro e
// pareggia. Il referto dice «compatibile con», non «è».

const { apiGet, scrivi, leggi, DIR_DATI } = require('./screening-lib');

const argomenti = process.argv.slice(2);
const arg = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? Number(argomenti[i + 1]) : difetto;
};
const SOGLIA_DUE_LATI = arg('--due-lati', 0.30);
const SOGLIA_RAPPORTO_PNL = arg('--rapporto-pnl', 1.0);
/** Quanti mercati arricchire con la configurazione reward di Gamma. */
const MERCATI_DA_ARRICCHIRE = 120;

const usd = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n))
  ? 'n/d' : '$' + n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });

async function configurazioneMercati(conditionIds) {
  // Gamma accetta `condition_ids` ripetuto. Si chiede a blocchi per non fare una URL infinita.
  const fuori = new Map();
  const BLOCCO = 20;
  for (let i = 0; i < conditionIds.length; i += BLOCCO) {
    const pezzo = conditionIds.slice(i, i + BLOCCO);
    const qs = pezzo.map((c) => `condition_ids=${c}`).join('&');
    const r = await apiGet(`/markets?${qs}`, 0, 'gamma-api.polymarket.com');
    if (!r.ok || !Array.isArray(r.dati)) continue;   // assente ≠ zero: il campo resta null
    for (const m of r.dati) {
      fuori.set(String(m.conditionId), {
        minSize: Number(m.rewardsMinSize),
        maxSpread: Number(m.rewardsMaxSpread),
        volume24h: Number(m.volume24hr),
        liquidita: Number(m.liquidity),
        endDate: m.endDate || null,
        chiuso: m.closed === true,
      });
    }
  }
  return fuori;
}

/** Il referto leggibile. Stesso posto e stessa forma delle altre sintesi di ricerca del repo. */
function scriviMarkdown(out) {
  const r = [];
  const n = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x))
    ? 'n/d' : x.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });

  r.push('# Screening dei maker da liquidity rewards — 14 giorni, sola lettura');
  r.push('');
  r.push(`Generato ${out.generatoIl}. Finestra **${out.finestra.da} … ${out.finestra.a}** (14 date di pagamento).`);
  r.push('Fonti: `data-api.polymarket.com` (`/activity`, `/positions`, `/value`), `lb-api.polymarket.com/profit`,');
  r.push('`gamma-api.polymarket.com/markets`, RPC Polygon (ricevuta della tx e `balanceOf` pUSD). **Nessuna transazione.**');
  r.push('');
  r.push('## L\'imbuto');
  r.push('');
  r.push('| passo | wallet |');
  r.push('|---|---|');
  r.push(`| destinatari del batch indicato | 400 |`);
  r.push(`| destinatari dell'intera giornata (6 batch) | ${out.universo.esaminatiNellaGiornata} |`);
  r.push(`| ricorrenza ≥10/14 · mediana ≥$1 · >1 pagamento | ${out.universo.candidatiDopoRicorrenzaEImporto} |`);
  r.push(`| due-lateralità ≥${(out.soglie.dueLati * 100).toFixed(0)}% · \\|P&L 7g\\| ≤ rewards 7g | **${out.passati}** |`);
  r.push(`| …di cui nel batch dei 400 | ${out.passatiNelBatchDei400} |`);
  r.push('');
  r.push('## I primi 20 per rewards nei 14 giorni');
  r.push('');
  r.push('| # | wallet | rewards 14g | mediana/g | mercati quotati | capitale stimato | 2 lati | P&L 7g |');
  r.push('|---|---|---|---|---|---|---|---|');
  out.primi20.forEach((w, i) => {
    r.push(`| ${i + 1} | \`${w.wallet}\` | $${n(w.rewards14g)} | $${n(w.medianaGiornaliera)} | ${w.mercatiConPosizione}${w.troncato ? '+' : ''} / ${w.mercatiScambiati} | ${w.capitaleStimato === null ? 'n/d' : '$' + n(w.capitaleStimato, 0)} | ${(w.quotaDueLati * 100).toFixed(0)}% | ${w.pnl7g === null ? 'n/d' : '$' + n(w.pnl7g, 0)} |`);
  });
  r.push('');
  r.push('«mercati quotati» = mercati con posizione ≥$5 **/** mercati distinti nel campione degli ultimi 500 trade.');
  r.push('`+` = elenco posizioni troncato a 500 righe ordinate per valore. «capitale stimato» = pUSD nel wallet + valore delle posizioni.');
  r.push('');
  r.push('## I mercati più quotati dal gruppo');
  r.push('');
  r.push('| maker | con posizione | con trade | minSize | maxSpread | mercato |');
  r.push('|---|---|---|---|---|---|');
  for (const m of out.classificaMercati.slice(0, 40)) {
    r.push(`| **${m.makerUnione}** | ${m.makerConPosizione} | ${m.makerConTrade} | ${m.minSize ?? '?'} | ${m.maxSpread ?? '?'} | ${(m.title || m.slug || m.conditionId).replace(/\|/g, '/')} |`);
  }
  r.push('');
  r.push('## Per famiglia');
  r.push('');
  r.push('| famiglia | mercati | presenze |');
  r.push('|---|---|---|');
  for (const f of out.perFamiglia) r.push(`| ${f.famiglia} | ${f.mercati} | ${f.presenzeMaker} |`);
  r.push('');
  r.push(`## Per \`minSize\` del venue (sui ${MERCATI_DA_ARRICCHIRE} mercati più quotati)`);
  r.push('');
  r.push('| minSize | presenze |');
  r.push('|---|---|');
  for (const s of out.perMinSize) r.push(`| ${s.minSize} | ${s.presenzeMaker} |`);

  // `scrivi` serializza in JSON: qui il contenuto è già testo, quindi si scrive diretto.
  const percorso = require('path').join(DIR_DATI, 'sintesi-screening-maker.md');
  require('fs').writeFileSync(percorso, r.join('\n') + '\n');
  return percorso;
}

async function main() {
  const storico = leggi('screening-02-storico.json');
  const posiz = leggi('screening-03-posizioni.json');
  const S = new Map(storico.righe.map((r) => [r.wallet, r]));

  // La finestra dei 7 giorni per il confronto con `pnl7g`: le ultime 7 date della finestra dei 14.
  const fine = Date.parse(storico.finestra.a + 'T00:00:00Z');
  const g7 = [];
  for (let i = 6; i >= 0; i -= 1) g7.push(new Date(fine - i * 86400_000).toISOString().slice(0, 10));

  const arricchiti = [];
  for (const p of posiz.righe) {
    if (!p.ok) continue;
    const s = S.get(p.wallet);
    if (!s) continue;
    const rewards7g = g7.reduce((a, g) => a + (s.perData[g] || 0), 0);
    const rapporto = (p.pnl7g === null || rewards7g <= 0) ? null : Math.abs(p.pnl7g) / rewards7g;
    arricchiti.push({
      wallet: p.wallet,
      nelBatch: s.nelBatch === true,
      giorniAttivi: s.giorniAttivi,
      rewards14g: s.rewards14g,
      medianaGiornaliera: s.medianaGiornaliera,
      rewards7g,
      pnl7g: p.pnl7g,
      rapportoPnlRewards: rapporto,
      quotaDueLati: p.quotaDueLati,
      mercatiDueLati: p.mercatiDueLati,
      mercatiScambiati: p.mercatiScambiati,
      arcoOre: p.arcoOre,
      mercatiConPosizione: p.mercatiConPosizione,
      mercatiAppaiati: p.mercatiAppaiati,
      simmetriaMedia: p.simmetriaMedia,
      capitaleStimato: p.capitaleStimato,
      contanteUsd: p.contanteUsd,
      valorePosizioni: p.valorePosizioni,
      troncato: p.troncato,
      mercati: p.mercati,
      mercatiRecenti: p.mercatiRecenti,
    });
  }

  // ── I FILTRI ② e ③ ────────────────────────────────────────────────────────────────────────────
  // ⚠ `rapporto === null` significa NON MISURATO (P&L illeggibile o zero reward nei 7 giorni), e non
  // passa: un filtro che accetta ciò che non ha misurato non è un filtro.
  const passati = arricchiti.filter((r) => r.quotaDueLati >= SOGLIA_DUE_LATI
    && r.rapportoPnlRewards !== null && r.rapportoPnlRewards <= SOGLIA_RAPPORTO_PNL);

  passati.sort((a, b) => b.rewards14g - a.rewards14g);
  const venti = passati.slice(0, 20);

  // ── LA CLASSIFICA DEI MERCATI ─────────────────────────────────────────────────────────────────
  // «Ci stanno dentro» = ha una posizione ≥ $5 in quel mercato (stadio 3). Si conta anche chi ci ha
  // SCAMBIATO di recente, perché un mercato appena aperto o appena chiuso in pari non lascia
  // posizione ma è quotato eccome. Le due colonne restano separate: sono due domande diverse.
  const perMercato = new Map();
  const tocca = (cid, campo, w, extra = {}) => {
    if (!cid) return;
    if (!perMercato.has(cid)) {
      perMercato.set(cid, { conditionId: cid, title: '', slug: '', endDate: null, conPosizione: new Set(), conTrade: new Set(), valore: 0 });
    }
    const m = perMercato.get(cid);
    m[campo].add(w);
    if (extra.title && !m.title) m.title = extra.title;
    if (extra.slug && !m.slug) m.slug = extra.slug;
    if (extra.endDate && !m.endDate) m.endDate = extra.endDate;
    if (Number.isFinite(extra.valore)) m.valore += extra.valore;
  };
  for (const r of passati) {
    for (const m of r.mercati || []) {
      tocca(m.conditionId, 'conPosizione', r.wallet, { title: m.title, slug: m.slug, endDate: m.endDate, valore: m.valore });
    }
    for (const m of r.mercatiRecenti || []) {
      tocca(m.conditionId, 'conTrade', r.wallet, { title: m.title, slug: m.slug });
    }
  }

  const classifica = [...perMercato.values()]
    .map((m) => ({
      conditionId: m.conditionId, title: m.title, slug: m.slug, endDate: m.endDate,
      makerConPosizione: m.conPosizione.size,
      makerConTrade: m.conTrade.size,
      makerUnione: new Set([...m.conPosizione, ...m.conTrade]).size,
      valoreGruppo: m.valore,
    }))
    // ⚠ SI ORDINA PER UNIONE, non per sola posizione, e la ragione è misurata: contando le sole
    // posizioni il massimo è **5 maker su 65** e 1.909 mercati su 2.363 hanno un maker solo — la
    // classifica è piatta perché una coppia completa viene fusa o riscattata e la posizione sparisce
    // (§5-bis p.150). Contando anche chi ci ha scambiato di recente il massimo sale a **13 su 65** e
    // la coda si separa. Le due colonne restano entrambe in tabella: sono due domande diverse.
    .sort((a, b) => b.makerUnione - a.makerUnione || b.makerConPosizione - a.makerConPosizione);

  const cfg = await configurazioneMercati(classifica.slice(0, MERCATI_DA_ARRICCHIRE).map((m) => m.conditionId));
  for (const m of classifica) {
    const c = cfg.get(m.conditionId);
    if (c) Object.assign(m, { minSize: c.minSize, maxSpread: c.maxSpread, volume24h: c.volume24h, liquidita: c.liquidita, chiuso: c.chiuso, endDate: c.endDate || m.endDate });
  }

  // ── LE FAMIGLIE ───────────────────────────────────────────────────────────────────────────────
  // I singoli mercati meteo scadono ogni giorno: la classifica per NOME invecchia in 24 ore, la
  // classifica per FAMIGLIA no. È la vista che sopravvive al giorno in cui è stata misurata.
  // ⚠ CLASSIFICATORE A REGEX, quindi APPROSSIMATO: è una vista di lettura, non una misura. Tarato
  // guardando i titoli davvero presenti (il primo giro schiacciava 2.180 mercati su «altro», fra cui
  // geopolitica, modelli AI e box office); «altro» resta e resta grande, perché una categoria
  // inventata per svuotarlo sarebbe peggio di una categoria onesta che dice «vario».
  const famiglia = (t) => {
    const s = String(t || '').toLowerCase();
    if (/temperature|rain|weather|°c|°f/.test(s)) return 'meteo';
    if (/bitcoin|ethereum|solana|crypto|\bbtc\b|\beth\b|\bxrp\b|dogecoin/.test(s)) return 'cripto';
    if (/fed |fed rate|interest rate|rate cut|inflation|\bcpi\b|\bgdp\b|jolts|crude|oil|s&p|nasdaq|market cap|home value/.test(s)) return 'macro-finanza';
    if (/iran|israel|ceasefire|invade|blockade|ukraine|russia|nato|war |troops|treaty|sanction/.test(s)) return 'geopolitica';
    if (/election|nominee|president|governor|parliament|minister|senate|gubernatorial|\bparty\b|congress|house members|signed into law|\bh\.r\./.test(s)) return 'politica';
    if (/\bai\b|gpt|gemini|claude|anthropic|openai|llm|model on|ai model|ai lab|baidu|deepseek/.test(s)) return 'ai-tech';
    if (/netflix|box office|opening weekend|domestic gross|season \d|big brother|billboard|emmy|oscar|grammy|mrbeast|video get/.test(s)) return 'intrattenimento';
    if (/join |transfer|ballon|premier league|champions|nba|nfl|mlb|\bf1\b|world cup|stay at|vs\./.test(s)) return 'sport';
    return 'altro';
  };
  const perFamiglia = new Map();
  const perMinSize = new Map();
  for (const m of classifica) {
    const f = famiglia(m.title);
    if (!perFamiglia.has(f)) perFamiglia.set(f, { famiglia: f, mercati: 0, presenzeMaker: 0, makerDistinti: new Set() });
    const v = perFamiglia.get(f);
    v.mercati += 1;
    v.presenzeMaker += m.makerUnione;
    if (m.minSize !== undefined && Number.isFinite(m.minSize)) {
      const k = String(m.minSize);
      perMinSize.set(k, (perMinSize.get(k) || 0) + m.makerUnione);
    }
  }

  const out = {
    generatoIl: new Date().toISOString(),
    finestra: storico.finestra,
    universo: { esaminatiNellaGiornata: storico.righe.length, candidatiDopoRicorrenzaEImporto: posiz.candidati },
    soglie: { dueLati: SOGLIA_DUE_LATI, rapportoPnlRewards: SOGLIA_RAPPORTO_PNL },
    passati: passati.length,
    passatiNelBatchDei400: passati.filter((r) => r.nelBatch).length,
    // L'elenco completo dei sopravvissuti, non solo i primi 20: lo stadio 5 parte da qui invece di
    // riapplicare i filtri per conto proprio, che sarebbe la settima copia di una soglia (reperto D1).
    passatiWallet: passati.map((r) => ({ wallet: r.wallet, rewards14g: r.rewards14g, quotaDueLati: r.quotaDueLati })),
    // ⚠ `mercati` e `mercatiRecenti` NON entrano nel referto: sono gli elenchi per-wallet, valgono
    // ~64 MB su 1.302 wallet e sono già serviti a costruire la classifica. Restano negli stadi 2 e 3,
    // che sono intermedi rigenerabili e non si committano.
    primi20: venti.map(({ mercati, mercatiRecenti, ...resto }) => resto),
    classificaMercati: classifica,
    perFamiglia: [...perFamiglia.values()].sort((a, b) => b.presenzeMaker - a.presenzeMaker)
      .map(({ famiglia: f, mercati, presenzeMaker }) => ({ famiglia: f, mercati, presenzeMaker })),
    perMinSize: [...perMinSize.entries()].sort((a, b) => b[1] - a[1])
      .map(([minSize, presenzeMaker]) => ({ minSize: Number(minSize), presenzeMaker })),
  };
  const f = scrivi('screening-04-referto.json', out);
  scriviMarkdown(out);

  // ── STAMPA ────────────────────────────────────────────────────────────────────────────────────
  console.log(`\nfinestra ${storico.finestra.da} … ${storico.finestra.a}`);
  console.log(`universo ${storico.righe.length} → dopo ricorrenza+importo ${posiz.candidati} → dopo due-lateralità+P&L ${passati.length}`);
  console.log(`di cui nel batch della tx indicata: ${out.passatiNelBatchDei400}\n`);

  console.log('wallet                                     | rewards 14g |  mediana/g | 2 lati | mercati | capitale stim.');
  console.log('-'.repeat(112));
  for (const r of venti) {
    console.log([
      r.wallet,
      usd(r.rewards14g).padStart(11),
      usd(r.medianaGiornaliera).padStart(10),
      (r.quotaDueLati * 100).toFixed(0).padStart(5) + '%',
      String(r.mercatiConPosizione).padStart(7) + (r.troncato ? '+' : ' '),
      (r.capitaleStimato === null ? 'n/d' : usd(r.capitaleStimato, 0)).padStart(14),
    ].join(' | '));
  }

  console.log('\n\nMERCATI PIÙ QUOTATI DAL GRUPPO');
  console.log('tot | pos | trade | minSz | spread | mercato');
  console.log('-'.repeat(112));
  for (const m of classifica.slice(0, 30)) {
    console.log([
      String(m.makerUnione).padStart(3),
      String(m.makerConPosizione).padStart(3),
      String(m.makerConTrade).padStart(5),
      (m.minSize === undefined ? '?' : String(m.minSize)).padStart(5),
      (m.maxSpread === undefined ? '?' : String(m.maxSpread)).padStart(6),
      (m.title || m.slug || m.conditionId).slice(0, 68),
    ].join(' | '));
  }

  console.log('\nPER FAMIGLIA (presenze = somma dei maker per mercato)');
  for (const f of out.perFamiglia) {
    console.log(`  ${f.famiglia.padEnd(14)} mercati ${String(f.mercati).padStart(5)} · presenze ${String(f.presenzeMaker).padStart(5)}`);
  }
  console.log(`\nPER minSize DEL VENUE (sui ${MERCATI_DA_ARRICCHIRE} mercati più quotati)`);
  for (const s of out.perMinSize) {
    console.log(`  minSize ${String(s.minSize).padStart(4)} → presenze ${String(s.presenzeMaker).padStart(4)}`);
  }
  console.log(`\nscritto ${f}`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });

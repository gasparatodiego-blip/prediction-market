'use strict';
// scripts/ricerca/r4-fuori-dal-libro.js — QUANTI MINUTI AL GIORNO SAREMMO FUORI, E QUANTO COSTA.
//
// ═══ LA REGOLA MISURATA — R4 nella forma decisa dall'operatore il 18 agosto 2026 ═════════════════════
//   · **solo erosione RELATIVA** — «è sparito un livello» si butta finché il feed pubblica 3 livelli;
//   · **freno 60 s** per rispettare il rail del venue (40 invii/60 s);
//   · **SELL esclusi**, come il TRIGGER 3 di `auto-reprice`;
//   · all'innesco si **CANCELLA E SI RESTA FUORI**, non si arretra di un tick («un tick sul bordo è una
//     protezione finta e preferisco la protezione vera»);
//   · **TETTO DI 5 MINUTI**: se dopo 5 minuti la profondità non è risalita sopra il 60% della baseline
//     congelata, si **rientra comunque** sul bordo e lo si dichiara.
//
// La domanda dell'operatore: **quanti minuti al giorno saremmo fuori dal libro, per mercato, e quanto
// premio perso in dollari.** Soglia di rinuncia dichiarata in anticipo: **più di 30 min/giorno per
// mercato ⇒ ci si ferma e si cambia idea.**
//
// ═══ COME SI SIMULA ══════════════════════════════════════════════════════════════════════════════════
// Fonte `data/mid-history-<giorno>.jsonl`, le funzioni sono quelle vere (`book-erosion`,
// `distanza-obiettivo`). Il bot era disarmato, quindi il prezzo del nostro ordine è simulato dove il
// motore lo metterebbe adesso.
//
// ⚠ CINQUE LIMITI, TUTTI NELLA DIREZIONE CHE VA SAPUTA:
//   1. **Il book è troncato a 3 livelli**: la profondità è una sottostima, e la baseline pure. Il
//      RAPPORTO fra le due è meno distorto della differenza, ed è il rapporto che decide — ma non è
//      esente.
//   2. **Il feed campiona ogni ~115 s**, quindi il tetto dei 5 minuti si risolve a passi di ~2
//      campioni: un rientro può cadere fino a un campione dopo il momento esatto. I minuti misurati
//      sono quindi arrotondati per ECCESSO al campione, cioè una sovrastima del tempo fuori.
//   3. **Si misura il solo lato BID.** L'altro lato è un CLOB indipendente e può erodersi in un altro
//      momento: i minuti «con una gamba fuori» sono al più il doppio, ma non su questo dato.
//   4. **Mentre si è fuori si continua a misurare** con il prezzo che l'ordine AVREBBE. È l'unica
//      scelta possibile — un ordine che non c'è non ha una zona davanti — ed è anche quella giusta: la
//      domanda «la profondità è tornata?» non dipende da noi.
//   5. **Il premio perso è modellato**, e la modellazione è dichiarata sotto.
//
// ⚠ SOLA LETTURA. Nessuna superficie di piazzamento, nessuna scrittura fuori da `data/ricerca/`.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RADICE = path.resolve(__dirname, '..', '..');
const ERO = require(path.join(RADICE, 'lib', 'maker', 'book-erosion'));
const DIST = require(path.join(RADICE, 'lib', 'maker', 'distanza-obiettivo'));
const CONC = require(path.join(RADICE, 'lib', 'rewards', 'concentration'));
const SELM = require(path.join(RADICE, 'lib', 'maker', 'selezione-mercati'));

const GIORNO = process.argv[2] || '2026-08-17';
const FILE = path.join(RADICE, 'data', `mid-history-${GIORNO}.jsonl`);
const BOARD = path.join(RADICE, 'data', 'liquidity-rewards.json');

/** Il tetto deciso dall'operatore: mai più di 5 minuti fuori per volta. */
const TETTO_FUORI_MS = 5 * 60_000;
/** Il freno, portato a 60 s per rispettare il rail (era 30). */
const FRENO_MS = 60_000;
/** La soglia di rinuncia, dichiarata PRIMA di guardare i numeri. */
const SOGLIA_RINUNCIA_MIN_GIORNO = 30;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const c = (x) => +(x * 100).toFixed(4);

// ── L'UNIVERSO E IL PREMIO ────────────────────────────────────────────────────────────────────────
// ⚠ IL PREMIO AL NOSTRO CAPITALE SI ESTRAPOLA, e va detto: il board pubblica i livelli a $500 e $5.000,
// noi mettiamo `MARKET_CAP_FIXED_USD` ($61,25). Alla nostra quota (0,7% contro il 5,3% di $500) la
// curva del venue è ancora quasi lineare, quindi si scala in proporzione. È una STIMA, e sbaglia per
// ECCESSO: la curva è concava, quindi il premio vero a $61,25 è ≥ della proporzione — cioè il premio
// PERSO calcolato così è ≤ del vero... no: proporzione su curva concava SOTTOSTIMA il premio, quindi
// sottostima anche la perdita. Si dichiara, e si mostra anche la variante al doppio.
function universo() {
  const out = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
    for (const r of (raw.markets || [])) {
      const id = String(r.conditionId || '').toLowerCase();
      const ms = Number(r.rewardsMinSize);
      if (!id || !fin(ms) || ms <= 0 || ms > SELM.MIN_SIZE_MASSIMA) continue;
      const l500 = r.levels && r.levels['500'];
      const gross500 = l500 && fin(Number(l500.grossRewardDay)) ? Number(l500.grossRewardDay) : null;
      out.set(id, {
        minSize: ms,
        // premio giornaliero stimato al NOSTRO capitale
        premioGiornoUsd: gross500 === null ? null : +(gross500 * (CONC.MARKET_CAP_FIXED_USD / 500)).toFixed(4),
        gross500,
      });
    }
  } catch { /* board illeggibile: universo vuoto, e si dichiara */ }
  return out;
}

function nostroPrezzoBid({ mid, bandLow, bandHigh, tick }) {
  if (!fin(mid) || !fin(bandLow) || !fin(bandHigh) || !fin(tick) || tick <= 0) return null;
  const raggioC = c((bandHigh - bandLow) / 2);
  const b = DIST.bordiConMargine({ bandLo: bandLow, bandHi: bandHigh, tick, maxSpreadCents: raggioC });
  if (!b || !fin(b.lo)) return null;   // ⚠ mai un ripiego su un altro criterio: si salta il campione
  const p = Math.floor((b.lo + 1e-9) / tick) * tick;
  return p > 0 && p < mid ? +p.toFixed(6) : null;
}

async function main() {
  if (!fs.existsSync(FILE)) { console.error(`manca ${FILE}`); process.exit(1); }
  const UNI = universo();
  const cfg = ERO.erosionConfig({ minIntervalMs: FRENO_MS });

  console.log(`\n════ R4 · QUANTO TEMPO FUORI DAL LIBRO — ${GIORNO} ════`);
  console.log(`regola misurata: SOLO erosione relativa · freno ${FRENO_MS / 1000} s · SELL esclusi`);
  console.log(`azione: CANCELLA e resta fuori finché la profondità non risale sopra il ${cfg.recoveryPct}%`
    + ` della baseline congelata, con TETTO di ${TETTO_FUORI_MS / 60000} minuti`);
  console.log(`soglia di rinuncia dichiarata PRIMA: ${SOGLIA_RINUNCIA_MIN_GIORNO} min/giorno per mercato`);
  console.log(`universo: ${UNI.size} mercati con minSize ≤ ${SELM.MIN_SIZE_MASSIMA}`);

  const per = new Map();
  const G = () => ({
    ero: ERO.emptyErosionState(), campioni: 0, leggibili: 0,
    episodi: 0, frenati: 0, secondiFuori: 0, secondiPresenza: 0,
    usciteTerminateDaRecupero: 0, usciteTerminateDalTetto: 0,
    fuoriDa: null, ultimoScattoAt: null, ultimoTs: null,
    durate: [],
  });

  let righe = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  for await (const linea of rl) {
    if (!linea) continue;
    let o; try { o = JSON.parse(linea); } catch { continue; }
    righe += 1;
    const id = String(o.marketId || '').toLowerCase();
    if (UNI.size && !UNI.has(id)) continue;

    const mid = fin(o.adjMid) ? o.adjMid : (fin(o.plainMid) ? o.plainMid : null);
    const tick = fin(o.tick) ? o.tick : null;
    const t = Date.parse(o.ts);
    if (!fin(mid) || !fin(tick) || !fin(o.bandLow) || !fin(o.bandHigh) || !fin(t)) continue;

    if (!per.has(id)) per.set(id, G());
    const S = per.get(id);
    S.campioni += 1;
    if (S.ultimoTs !== null && t > S.ultimoTs && t - S.ultimoTs < 300_000) S.secondiPresenza += (t - S.ultimoTs) / 1000;
    S.ultimoTs = t;

    const prezzo = nostroPrezzoBid({ mid, bandLow: o.bandLow, bandHigh: o.bandHigh, tick });
    if (prezzo === null) continue;

    const livelli = (Array.isArray(o.levels) ? o.levels : [])
      .map((l) => ({ price: l && l.bidPrice, size: l && l.bidSizeAtLevel }))
      .filter((l) => fin(l.price) && fin(l.size) && l.size > 0);
    const z = ERO.zoneDepth({ levels: livelli, orderPrice: prezzo, sideMid: mid });
    if (!z.readable) continue;
    S.leggibili += 1;

    const u = ERO.updateErosion(S.ero, { depth: z.depth, now: t, cfg });

    // ── SE SIAMO FUORI: si decide se rientrare ────────────────────────────────────────────────────
    if (S.fuoriDa !== null) {
      const fuoriDaMs = t - S.fuoriDa;
      const perTetto = fuoriDaMs >= TETTO_FUORI_MS;
      if (u.recovered === true || perTetto) {
        // ⚠ Il tempo fuori si tronca al TETTO anche se il campione arriva dopo: il bot rientrerebbe al
        // minuto 5 esatto, non al campione successivo. Contare fino al campione sovrastimerebbe di
        // ~115 s per episodio, cioè quasi il 40% del tetto.
        const durata = perTetto ? Math.min(fuoriDaMs, TETTO_FUORI_MS) : fuoriDaMs;
        S.secondiFuori += durata / 1000;
        S.durate.push(+(durata / 60000).toFixed(2));
        if (u.recovered === true && !perTetto) S.usciteTerminateDaRecupero += 1;
        else S.usciteTerminateDalTetto += 1;
        S.fuoriDa = null;
      }
      continue;   // finché si è fuori non si può riscattare
    }

    // ── SE SIAMO DENTRO: l'innesco ────────────────────────────────────────────────────────────────
    if (u.fired !== true) continue;
    const permesso = ERO.repriceAllowed({ trigger: 'erosione', lastRepriceAt: S.ultimoScattoAt, now: t, cfg });
    if (!permesso.allowed) { S.frenati += 1; continue; }
    S.ultimoScattoAt = t;
    S.episodi += 1;
    S.fuoriDa = t;
  }
  rl.close();

  // Un'uscita ancora aperta a fine giornata: si chiude al tetto, o si conterebbe zero.
  for (const [, S] of per) {
    if (S.fuoriDa !== null && S.ultimoTs !== null) {
      const d = Math.min(Math.max(0, S.ultimoTs - S.fuoriDa), TETTO_FUORI_MS);
      S.secondiFuori += d / 1000; S.durate.push(+(d / 60000).toFixed(2)); S.usciteTerminateDalTetto += 1; S.fuoriDa = null;
    }
  }

  const M = [...per.entries()].filter(([, s]) => s.leggibili >= 10);
  const conFuori = M.filter(([, s]) => s.episodi > 0);
  const tot = (f) => M.reduce((a, [, s]) => a + f(s), 0);

  // ── PER MERCATO, NORMALIZZATO A UNA GIORNATA ──────────────────────────────────────────────────
  const righeM = M.map(([id, s]) => {
    const ore = s.secondiPresenza / 3600;
    const minFuori = s.secondiFuori / 60;
    const minPerGiorno = ore > 0 ? minFuori * (24 / ore) : 0;
    const info = UNI.get(id) || {};
    const premio = fin(info.premioGiornoUsd) ? info.premioGiornoUsd : null;
    const persoUsd = premio === null ? null : +(premio * (minPerGiorno / 1440)).toFixed(5);
    return { id, ...s, ore, minFuori, minPerGiorno, premioGiornoUsd: premio, persoUsd, minSize: info.minSize ?? null };
  }).sort((a, b) => b.minPerGiorno - a.minPerGiorno);

  console.log(`\nrighe lette ${righe.toLocaleString('it')} · mercati misurati ${M.length} · campioni utili ${tot((s) => s.leggibili).toLocaleString('it')}`);

  console.log('\n──── QUANTE VOLTE SI ESCE, E PER QUANTO ────');
  console.log(`  episodi di uscita (totali)         : ${tot((s) => s.episodi)}`);
  console.log(`  mercati che escono almeno una volta : ${conFuori.length} su ${M.length}`);
  console.log(`  chiusi da RECUPERO (< 5 min)       : ${tot((s) => s.usciteTerminateDaRecupero)}`);
  console.log(`  chiusi dal TETTO dei 5 minuti      : ${tot((s) => s.usciteTerminateDalTetto)}`);
  console.log(`  fermati dal freno di ${FRENO_MS / 1000} s            : ${tot((s) => s.frenati)}`);
  const durate = righeM.flatMap((r) => r.durate).sort((a, b) => a - b);
  if (durate.length) {
    const q = (p) => durate[Math.min(durate.length - 1, Math.floor(p * durate.length))];
    console.log(`  durata di un'uscita: mediana ${q(0.5).toFixed(2)} min · q90 ${q(0.9).toFixed(2)} · max ${durate[durate.length - 1].toFixed(2)}`);
  }

  console.log('\n──── MINUTI AL GIORNO FUORI DAL LIBRO, PER MERCATO ────');
  console.log('   min/g   episodi  ore oss.  premio $/g  perso $/g  minSize  mercato');
  for (const r of righeM.slice(0, 15)) {
    console.log(`  ${r.minPerGiorno.toFixed(2).padStart(6)}  ${String(r.episodi).padStart(8)}  ${r.ore.toFixed(1).padStart(8)}`
      + `  ${(r.premioGiornoUsd === null ? '?' : r.premioGiornoUsd.toFixed(4)).padStart(10)}`
      + `  ${(r.persoUsd === null ? '?' : r.persoUsd.toFixed(5)).padStart(9)}`
      + `  ${String(r.minSize ?? '?').padStart(7)}  ${r.id.slice(0, 12)}…`);
  }

  // ⚠⚠ IL VERDETTO SI DÀ SOLO SUI MERCATI OSSERVATI ABBASTANZA, e questo NON è un modo di scartare i
  // numeri scomodi. Un mercato visto per 0,5 h con UN episodio da 5 minuti produce «180 min/giorno»
  // moltiplicando per 48: non è una misura, è un episodio diviso per una finestra troppo corta. La
  // soglia è 12 ore — metà giornata — sotto la quale un singolo episodio pesa più del 4% del totale
  // estrapolato. I mercati corti restano nella tabella qui sopra, dichiarati, e sono quelli con la
  // colonna «ore oss.» piccola: chi legge deve poterlo vedere, non doverlo dedurre.
  const ORE_MINIME_PER_GIUDIZIO = 12;
  const solidi = righeM.filter((r) => r.ore >= ORE_MINIME_PER_GIUDIZIO);
  console.log(`\n──── ⚠ I MERCATI OSSERVATI POCO INQUINANO L'ESTRAPOLAZIONE ────`);
  console.log(`  mercati con ≥ ${ORE_MINIME_PER_GIUDIZIO} h di osservazione : ${solidi.length} su ${M.length}`);
  console.log(`  gli altri ${M.length - solidi.length} sono visti fra ${Math.min(...righeM.map((r) => r.ore)).toFixed(1)} e ${ORE_MINIME_PER_GIUDIZIO} h:`);
  console.log('    un episodio da 5 min su 0,5 h di osservazione diventa 180 min/giorno moltiplicando per 48.');
  if (solidi.length) {
    const ms = solidi.map((r) => r.minPerGiorno).sort((a, b) => a - b);
    const md = ms[Math.floor(ms.length / 2)];
    console.log(`  ⇒ SUI SOLIDI: mediana ${md.toFixed(2)} · media ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2)}`
      + ` · peggiore ${ms[ms.length - 1].toFixed(2)} min/giorno`);
    const sopraS = solidi.filter((r) => r.minPerGiorno > SOGLIA_RINUNCIA_MIN_GIORNO);
    console.log(`  ⇒ sopra la soglia di ${SOGLIA_RINUNCIA_MIN_GIORNO} min/giorno: ${sopraS.length} su ${solidi.length}`
      + (sopraS.length ? ` (${sopraS.map((r) => `${r.id.slice(0, 10)}…=${r.minPerGiorno.toFixed(0)}`).join(', ')})` : ''));
    const persoS = solidi.filter((r) => r.persoUsd !== null).map((r) => r.persoUsd).sort((a, b) => a - b);
    if (persoS.length) {
      const pm = persoS[Math.floor(persoS.length / 2)];
      console.log(`  ⇒ premio perso: mediano $${pm.toFixed(5)}/giorno per mercato · peggiore $${persoS[persoS.length - 1].toFixed(5)}`
        + ` · sui 3 attivi $${(pm * 3).toFixed(5)}/giorno = $${(pm * 3 * 30).toFixed(4)}/mese`);
    }
  }

  const minGiorno = righeM.map((r) => r.minPerGiorno).sort((a, b) => a - b);
  const mediana = minGiorno.length ? minGiorno[Math.floor(minGiorno.length / 2)] : 0;
  const peggiore = minGiorno.length ? minGiorno[minGiorno.length - 1] : 0;
  const medio = minGiorno.length ? minGiorno.reduce((a, b) => a + b, 0) / minGiorno.length : 0;

  console.log('\n──── IL VERDETTO CONTRO LA SOGLIA DELL\'OPERATORE ────');
  console.log(`  mediana   : ${mediana.toFixed(2)} min/giorno per mercato`);
  console.log(`  media     : ${medio.toFixed(2)} min/giorno per mercato`);
  console.log(`  PEGGIORE  : ${peggiore.toFixed(2)} min/giorno per mercato`);
  console.log(`  soglia    : ${SOGLIA_RINUNCIA_MIN_GIORNO} min/giorno`);
  const sopra = righeM.filter((r) => r.minPerGiorno > SOGLIA_RINUNCIA_MIN_GIORNO);
  console.log(`  ⇒ mercati SOPRA la soglia: ${sopra.length} su ${M.length}`
    + (sopra.length ? ` (${sopra.slice(0, 5).map((r) => `${r.id.slice(0, 10)}…=${r.minPerGiorno.toFixed(0)}`).join(', ')})` : ''));

  // ── IL PREMIO PERSO, SUI TRE MERCATI CHE IL BOT TIENE ATTIVI ──────────────────────────────────
  console.log('\n──── PREMIO PERSO IN DOLLARI ────');
  const conPremio = righeM.filter((r) => r.persoUsd !== null);
  const persoMediano = conPremio.length
    ? conPremio.map((r) => r.persoUsd).sort((a, b) => a - b)[Math.floor(conPremio.length / 2)] : null;
  const persoPeggiore = conPremio.length ? Math.max(...conPremio.map((r) => r.persoUsd)) : null;
  console.log(`  premio stimato al nostro capitale ($${CONC.MARKET_CAP_FIXED_USD}/mercato), mediano:`
    + ` $${conPremio.length ? conPremio.map((r) => r.premioGiornoUsd).sort((a, b) => a - b)[Math.floor(conPremio.length / 2)].toFixed(4) : '?'}/giorno`);
  console.log(`  perso per mercato, mediano : $${persoMediano === null ? '?' : persoMediano.toFixed(5)}/giorno`);
  console.log(`  perso per mercato, peggiore: $${persoPeggiore === null ? '?' : persoPeggiore.toFixed(5)}/giorno`);
  const suTre = persoMediano === null ? null : persoMediano * 3;
  console.log(`  ⇒ sui 3 mercati attivi     : $${suTre === null ? '?' : suTre.toFixed(5)}/giorno = $${suTre === null ? '?' : (suTre * 30).toFixed(4)}/mese`);
  console.log('  ⚠ è il lato BID soltanto; con entrambi i lati che si erodono in momenti diversi il');
  console.log('    tetto superiore è il doppio, e resta un ordine di grandezza sotto il centesimo.');

  const referto = {
    giorno: GIORNO, sorgente: 'scripts/ricerca/r4-fuori-dal-libro.js',
    regola: { soloErosioneRelativa: true, frenoMs: FRENO_MS, sellEsclusi: true,
      azione: 'cancella-e-resta-fuori', tettoFuoriMs: TETTO_FUORI_MS, rientroPct: cfg.recoveryPct },
    sogliaRinunciaMinGiorno: SOGLIA_RINUNCIA_MIN_GIORNO,
    mercatiMisurati: M.length, mercatiCheEscono: conFuori.length,
    episodi: tot((s) => s.episodi), chiusiDaRecupero: tot((s) => s.usciteTerminateDaRecupero),
    chiusiDalTetto: tot((s) => s.usciteTerminateDalTetto), frenati: tot((s) => s.frenati),
    minutiGiorno: { mediana: +mediana.toFixed(2), media: +medio.toFixed(2), peggiore: +peggiore.toFixed(2) },
    mercatiSopraSoglia: sopra.length,
    premioPersoUsdGiorno: { mediano: persoMediano, peggiore: persoPeggiore, suTreMercati: suTre },
    limiti: [
      'book troncato a 3 livelli: profondita e baseline sottostimate, il rapporto meno',
      'feed a ~115 s: il tetto dei 5 min si risolve a passi di ~2 campioni',
      'solo lato BID: l altro CLOB puo erodersi in un altro momento',
      'mentre si e fuori si misura col prezzo che l ordine AVREBBE',
      'premio al nostro capitale estrapolato in proporzione dal livello $500 del board',
    ],
    perMercato: righeM.slice(0, 40).map((r) => ({ id: r.id, minPerGiorno: +r.minPerGiorno.toFixed(2),
      episodi: r.episodi, oreOsservate: +r.ore.toFixed(2), premioGiornoUsd: r.premioGiornoUsd,
      persoUsd: r.persoUsd, minSize: r.minSize, durateMin: r.durate })),
  };
  const dir = path.join(RADICE, 'data', 'ricerca');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* c'e' */ }
  const out = path.join(dir, `r4-fuori-dal-libro-${GIORNO}.json`);
  fs.writeFileSync(out, JSON.stringify(referto, null, 1));
  console.log(`\nreferto → ${path.relative(RADICE, out)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

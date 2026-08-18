'use strict';
// scripts/ricerca/r4-erosione-su-giornata-vera.js — QUANTE VOLTE R4 SAREBBE SCATTATA, E QUANTO COSTA.
//
// ═══ LA DOMANDA ═════════════════════════════════════════════════════════════════════════════════════
// R4 (regola nuova, 18 agosto 2026): «Riprezza ANCHE se la profondita' davanti scende sotto 3x la
// propria size OPPURE se sparisce un livello di prezzo davanti: cancella e rimette sul bordo esterno,
// senza aspettare il mid. Freno: massimo uno spostamento ogni 30 s per mercato.»
//
// Prima di accenderla l'operatore ha chiesto: quante volte sarebbe scattata su una giornata VERA di
// book, e quanto premio sarebbe costata.
//
// ═══ COME SI MISURA, E COSA E' UNA STIMA ════════════════════════════════════════════════════════════
// La fonte e' `data/mid-history-<giorno>.jsonl`, scritta da agent34 dal websocket: ogni campione porta
// mid, banda, tick e i **primi 3 livelli** di bid e ask. Il bot il 17 agosto era DISARMATO, quindi non
// esistono ordini nostri da usare: il prezzo del nostro ordine si SIMULA con le funzioni vere della
// produzione (`distanza-obiettivo`), cioe' dove il bot lo metterebbe adesso.
//
// ⚠ TRE LIMITI DICHIARATI, e sono la ragione per cui questo e' un ORDINE DI GRANDEZZA:
//   1. **Il book e' troncato a 3 livelli.** La profondita' davanti e' quindi una SOTTOSTIMA quando il
//      nostro prezzo e' lontano dal tocco, e il rapporto con la baseline puo' essere distorto in
//      entrambe le direzioni. Non si puo' correggere: il dato non c'e'.
//   2. **La size nostra e' simulata** dal tetto per mercato e dal costo della coppia. Il criterio
//      «3x la propria size» dipende da lei.
//   3. **Il costo in premio e' MODELLATO**, non misurato: nessuno ha mai riprezzato per erosione, quindi
//      non esiste un consuntivo. Si modella come tempo fuori dal libro x tasso di maturazione.
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

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const c = (x) => +(x * 100).toFixed(4);

// ── L'UNIVERSO: i mercati che il bot potrebbe davvero scegliere ────────────────────────────────────
// Misurare su tutto il board direbbe quanto scatta su mercati che il bot non tocca. Si filtra con lo
// STESSO vincolo della selezione (`MIN_SIZE_MASSIMA`), importato e non ricopiato.
function universo() {
  try {
    const raw = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
    const out = new Map();
    for (const r of (raw.markets || [])) {
      const id = String(r.conditionId || '').toLowerCase();
      const ms = Number(r.rewardsMinSize);
      if (id && fin(ms) && ms > 0 && ms <= SELM.MIN_SIZE_MASSIMA) out.set(id, ms);
    }
    return out;
  } catch (e) { return new Map(); }
}

// ── DOVE STAREBBE IL NOSTRO ORDINE, con le funzioni vere ───────────────────────────────────────────
// `bordiConMargine` e' la stessa funzione che decide il bersaglio in produzione. Il prezzo si arrotonda
// sulla griglia verso il BASSO sul lato bid (piu' lontano dal mid): e' cio' che fa il motore.
function nostroPrezzoBid({ mid, bandLow, bandHigh, tick }) {
  if (!fin(mid) || !fin(bandLow) || !fin(bandHigh) || !fin(tick) || tick <= 0) return null;
  const raggioC = c((bandHigh - bandLow) / 2);
  // ⚠ IL CAMPO SI CHIAMA `lo`, NON `bandLo`. La prima stesura leggeva `b.bandLo` — `undefined` — e il
  // ripiego `: bandLow` la trasformava in «bordo NUDO», cioè il comportamento di prima del 16 agosto.
  // Risultato: la misura diceva «100% no-op» perché l'ordine simulato stava già sul bordo. È la classe
  // di §5.3 «dep col nome sbagliato ⇒ valore di difetto che nessuno ha chiesto», su uno script di
  // misura invece che su un modulo — e sbagliava nella direzione che fa sembrare la regola inutile.
  // Adesso un bersaglio non leggibile FERMA il campione invece di ripiegare su un altro criterio.
  const b = DIST.bordiConMargine({ bandLo: bandLow, bandHi: bandHigh, tick, maxSpreadCents: raggioC });
  if (!b || !fin(b.lo)) return null;
  const p = Math.floor((b.lo + 1e-9) / tick) * tick;
  return p > 0 && p < mid ? +p.toFixed(6) : null;
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`manca ${FILE}`);
    process.exit(1);
  }
  const UNI = universo();
  console.log(`\n════ R4 · L'EROSIONE SU UNA GIORNATA VERA — ${GIORNO} ════`);
  console.log(`universo: ${UNI.size} mercati del board con minSize ≤ ${SELM.MIN_SIZE_MASSIMA} (il vincolo della selezione)`);
  if (!UNI.size) console.log('⚠ board illeggibile o vuoto: si misura su TUTTI i mercati del giornale');

  const cfg = ERO.erosionConfig({});
  console.log(`taratura in servizio: trigger ${cfg.triggerPct}% · recupero ${cfg.recoveryPct}% · finestra ${cfg.windowMs / 60000} min`
    + ` · conferma ${cfg.confirmReadings} letture · riscaldamento ${cfg.minSamples} campioni / ${cfg.minSpanMs / 1000} s`
    + ` · freno ${cfg.minIntervalMs / 1000} s`);

  // Stato per mercato: la macchina dell'erosione + il conteggio dei livelli davanti + il freno.
  const per = new Map();
  const G = () => ({
    ero: ERO.emptyErosionState(), campioni: 0, leggibili: 0,
    scattiErosione: 0, scattiLivello: 0, scattiTotali: 0, frenati: 0,
    livelliPrec: null, ultimoScattoAt: null,
    giaAlBordo: 0, arretramentiVeri: 0, secondiInBanda: 0, ultimoTs: null,
    sottoTreVolte: 0, sottoUnaVolta: 0,
    minSize: null, raggioMedio: 0, nRaggio: 0,
  });

  let righe = 0; let scartate = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  for await (const linea of rl) {
    if (!linea) continue;
    let o;
    try { o = JSON.parse(linea); } catch { scartate += 1; continue; }
    righe += 1;
    const id = String(o.marketId || '').toLowerCase();
    if (UNI.size && !UNI.has(id)) continue;

    const mid = fin(o.adjMid) ? o.adjMid : (fin(o.plainMid) ? o.plainMid : null);
    const tick = fin(o.tick) ? o.tick : null;
    if (!fin(mid) || !fin(tick) || !fin(o.bandLow) || !fin(o.bandHigh)) continue;

    if (!per.has(id)) per.set(id, G());
    const S = per.get(id);
    S.campioni += 1;
    S.minSize = UNI.get(id) ?? null;
    const raggioC = c((o.bandHigh - o.bandLow) / 2);
    S.raggioMedio += raggioC; S.nRaggio += 1;

    const t = Date.parse(o.ts);
    if (!fin(t)) continue;
    if (S.ultimoTs !== null && t - S.ultimoTs > 0 && t - S.ultimoTs < 300_000) S.secondiInBanda += (t - S.ultimoTs) / 1000;
    S.ultimoTs = t;

    const prezzo = nostroPrezzoBid({ mid, bandLow: o.bandLow, bandHigh: o.bandHigh, tick });
    if (prezzo === null) continue;

    // I livelli BID, nella forma che `zoneDepth` si aspetta.
    const livelli = (Array.isArray(o.levels) ? o.levels : [])
      .map((l) => ({ price: l && l.bidPrice, size: l && l.bidSizeAtLevel }))
      .filter((l) => fin(l.price) && fin(l.size) && l.size > 0);

    const z = ERO.zoneDepth({ levels: livelli, orderPrice: prezzo, sideMid: mid });
    if (!z.readable) continue;
    S.leggibili += 1;

    // ── ① IL CRITERIO DELL'EROSIONE, con la macchina VERA ────────────────────────────────────────
    const u = ERO.updateErosion(S.ero, { depth: z.depth, now: t, cfg });

    // ── ①-bis IL CRITERIO LETTERALE DELL'OPERATORE: «profondita' davanti < 3x la propria size» ────
    // ⚠ Si misura ANCHE questo, separato, perche' non e' la stessa domanda dell'erosione: l'erosione
    // e' RELATIVA alla storia del mercato, questo e' ASSOLUTO rispetto alla nostra size. Un book
    // costantemente sottile e' «eroso» mai e «sotto 3x» sempre.
    const nostraSize = CONC.MARKET_CAP_FIXED_USD / 0.98;   // ~62,5 share, la coppia tipica di §4.4
    if (z.depth < 3 * nostraSize) S.sottoTreVolte += 1;
    if (z.depth < 1 * nostraSize) S.sottoUnaVolta += 1;

    // ── ② IL CRITERIO «E' SPARITO UN LIVELLO DAVANTI» ────────────────────────────────────────────
    // ⚠ Si conta un calo del NUMERO di livelli distinti fra noi e il mid. Un livello che sparisce senza
    // che il mid si muova e' esattamente il caso concreto dell'operatore.
    const livelloSparito = S.livelliPrec !== null && z.levels < S.livelliPrec;
    S.livelliPrec = z.levels;

    const vuoleScattare = u.fired === true || livelloSparito;
    if (!vuoleScattare) continue;

    // ── ③ IL FRENO DEI 30 s ──────────────────────────────────────────────────────────────────────
    const permesso = ERO.repriceAllowed({ trigger: 'erosione', lastRepriceAt: S.ultimoScattoAt, now: t, cfg });
    if (!permesso.allowed) { S.frenati += 1; continue; }
    S.ultimoScattoAt = t;
    S.scattiTotali += 1;
    if (u.fired) S.scattiErosione += 1;
    if (livelloSparito) S.scattiLivello += 1;

    // ── ④ E DOVE SI ANDREBBE? Se siamo gia' al bordo, «rimetti sul bordo esterno» e' un no-op ─────
    const offsetC = c(mid - prezzo);
    const r = ERO.erosionRetreat({ offsetCents: offsetC, bandRadiusCents: raggioC, tick });
    if (r.ok) S.arretramentiVeri += 1; else S.giaAlBordo += 1;
  }
  rl.close();

  // ── IL REFERTO ────────────────────────────────────────────────────────────────────────────────
  const M = [...per.entries()].filter(([, s]) => s.leggibili >= 10)
    .sort((a, b) => b[1].scattiTotali - a[1].scattiTotali);
  const tot = (f) => M.reduce((a, [, s]) => a + f(s), 0);

  console.log(`\nrighe lette: ${righe.toLocaleString('it')}${scartate ? ` (${scartate} scartate)` : ''}`);
  console.log(`mercati con almeno 10 letture utili: ${M.length}`);
  console.log(`campioni utili: ${tot((s) => s.leggibili).toLocaleString('it')} su ${tot((s) => s.campioni).toLocaleString('it')} osservati`);

  console.log('\n──── QUANTE VOLTE SAREBBE SCATTATA ────');
  console.log(`  scatti TOTALI (dopo il freno)      : ${tot((s) => s.scattiTotali).toLocaleString('it')}`);
  console.log(`    di cui per EROSIONE (< 40% base) : ${tot((s) => s.scattiErosione).toLocaleString('it')}`);
  console.log(`    di cui per LIVELLO SPARITO       : ${tot((s) => s.scattiLivello).toLocaleString('it')}`);
  console.log(`  fermati dal freno dei ${cfg.minIntervalMs / 1000} s          : ${tot((s) => s.frenati).toLocaleString('it')}`);
  const senzaFreno = tot((s) => s.scattiTotali) + tot((s) => s.frenati);
  console.log(`  ⚠ senza freno sarebbero stati      : ${senzaFreno.toLocaleString('it')}`
    + (senzaFreno > 0 ? ` (il freno ne toglie il ${(100 * tot((s) => s.frenati) / senzaFreno).toFixed(1)}%)` : ''));

  console.log('\n──── IL CRITERIO LETTERALE: «profondità davanti < 3× la propria size» ────');
  const nostra = CONC.MARKET_CAP_FIXED_USD / 0.98;
  const util = tot((s) => s.leggibili);
  console.log(`  la nostra size tipica è ${nostra.toFixed(1)} share ⇒ la soglia è ${(3 * nostra).toFixed(1)} share davanti`);
  console.log(`  campioni SOTTO 3×  : ${tot((s) => s.sottoTreVolte).toLocaleString('it')} su ${util.toLocaleString('it')}`
    + ` = ${util ? (100 * tot((s) => s.sottoTreVolte) / util).toFixed(1) : 0}% del tempo`);
  console.log(`  campioni SOTTO 1×  : ${tot((s) => s.sottoUnaVolta).toLocaleString('it')} su ${util.toLocaleString('it')}`
    + ` = ${util ? (100 * tot((s) => s.sottoUnaVolta) / util).toFixed(1) : 0}% del tempo`);
  console.log('  ⚠ questo NON è un conteggio di scatti: è la frazione di tempo in cui la condizione è VERA.');
  console.log('    Un criterio vero quasi sempre non è un trigger, è uno stato — e come trigger scatterebbe');
  console.log('    una volta e poi resterebbe armato, oppure a ogni campione se lo si legge senza isteresi.');

  console.log('\n──── DOVE ANDREBBE L\'ORDINE ────');
  const gia = tot((s) => s.giaAlBordo); const veri = tot((s) => s.arretramentiVeri);
  console.log(`  arretramenti VERI (c'è spazio)     : ${veri.toLocaleString('it')}`);
  console.log(`  già al bordo ⇒ NO-OP               : ${gia.toLocaleString('it')}`
    + (veri + gia > 0 ? ` (${(100 * gia / (veri + gia)).toFixed(1)}%)` : ''));

  console.log('\n──── I DIECI MERCATI CHE SCATTEREBBERO DI PIÙ ────');
  console.log('  scatti  ero  liv  fren  campioni  ore  scatti/h  minSize  raggio');
  for (const [id, s] of M.slice(0, 10)) {
    const ore = s.secondiInBanda / 3600;
    console.log(`  ${String(s.scattiTotali).padStart(6)}  ${String(s.scattiErosione).padStart(3)}  ${String(s.scattiLivello).padStart(3)}`
      + `  ${String(s.frenati).padStart(4)}  ${String(s.leggibili).padStart(8)}  ${ore.toFixed(1).padStart(4)}`
      + `  ${(ore > 0 ? s.scattiTotali / ore : 0).toFixed(1).padStart(8)}  ${String(s.minSize ?? '?').padStart(7)}`
      + `  ${(s.nRaggio ? s.raggioMedio / s.nRaggio : 0).toFixed(2).padStart(6)}¢  ${id.slice(0, 12)}…`);
  }

  // ── IL COSTO IN PREMIO, MODELLATO ─────────────────────────────────────────────────────────────
  // Ogni riprezzo e' cancel+place: l'ordine sta FUORI dal libro per il tempo del round-trip, e in quel
  // tempo non matura. Non c'e' un consuntivo — nessuno ha mai riprezzato per erosione — quindi si
  // modella con la latenza misurata della corsia manuale.
  console.log('\n──── QUANTO PREMIO COSTEREBBE (MODELLATO, non misurato) ────');
  const scatti = tot((s) => s.scattiTotali);
  const oreTot = tot((s) => s.secondiInBanda) / 3600;
  for (const latenzaSec of [0.5, 1, 2]) {
    const fuoriSec = scatti * latenzaSec;
    const quota = oreTot > 0 ? fuoriSec / (oreTot * 3600) : 0;
    console.log(`  round-trip ${latenzaSec}s ⇒ ${fuoriSec.toFixed(0)} s fuori dal libro su ${(oreTot * 3600).toFixed(0)} s di presenza`
      + ` = ${(quota * 100).toFixed(3)}% del premio`);
  }
  console.log(`  ⚠ e su TRE mercati (il tetto di oggi) gli scatti sarebbero ~${M.length ? (scatti / M.length * 3).toFixed(0) : 0} al giorno`);
  console.log(`  ⚠ il tetto di invii e' 40/60 s con quota 60/40: ${scatti} riprezzi in 24 h sono ${(scatti / 1440).toFixed(2)}/min in media`);

  const referto = {
    giorno: GIORNO, generatoDaSorgente: 'scripts/ricerca/r4-erosione-su-giornata-vera.js',
    universo: UNI.size, mercatiMisurati: M.length,
    campioniUtili: tot((s) => s.leggibili), campioniOsservati: tot((s) => s.campioni),
    taratura: cfg,
    scattiTotali: scatti, scattiErosione: tot((s) => s.scattiErosione),
    scattiLivelloSparito: tot((s) => s.scattiLivello), frenati: tot((s) => s.frenati),
    senzaFreno, arretramentiVeri: veri, giaAlBordoNoOp: gia,
    nostraSizeShare: +nostra.toFixed(2),
    campioniSottoTreVolte: tot((s) => s.sottoTreVolte), campioniSottoUnaVolta: tot((s) => s.sottoUnaVolta),
    oreDiPresenza: +oreTot.toFixed(2),
    limiti: [
      'book troncato a 3 livelli dal feed: la profondita davanti e una SOTTOSTIMA',
      'la size nostra e simulata, e il criterio 3x dipende da lei',
      'il costo in premio e MODELLATO sulla latenza, non misurato: nessuno ha mai riprezzato per erosione',
    ],
    perMercato: M.slice(0, 30).map(([id, s]) => ({ id, scatti: s.scattiTotali, erosione: s.scattiErosione,
      livello: s.scattiLivello, frenati: s.frenati, campioni: s.leggibili,
      ore: +(s.secondiInBanda / 3600).toFixed(2), minSize: s.minSize,
      raggioMedioCents: s.nRaggio ? +(s.raggioMedio / s.nRaggio).toFixed(2) : null })),
  };
  const dir = path.join(RADICE, 'data', 'ricerca');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* c'e' gia' */ }
  const out = path.join(dir, `r4-erosione-${GIORNO}.json`);
  fs.writeFileSync(out, JSON.stringify(referto, null, 1));
  console.log(`\nreferto → ${path.relative(RADICE, out)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });

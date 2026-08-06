'use strict';
// lib/rewards/velocita-mercato.js — QUANTO SI MUOVE UN MERCATO, misurato invece che immaginato.
//
// ═══ PERCHÉ ESISTE ══════════════════════════════════════════════════════════════════════════════════
// La diagnosi del feed fermo del 6 agosto 2026 ha misurato una differenza che nessuna schermata
// mostrava: i mercati su cui il capitale era allocato erano da 5 a 13 volte più silenziosi della media
// del board. Campioni senza un solo evento websocket in 75 secondi — TX-15 26%, Ed Markey 18%, MI-10
// 16%, Rhode Island 10%, contro il 2% del resto del board.
//
// Non è una curiosità: su un mercato così, il guard sul mid vecchio di lib/maker/auto-reprice rifiuta
// di agire con un limite di 60s, cioè PIÙ STRETTO dell'intervallo naturale fra due eventi di quel
// mercato. Chi sceglie dove mettere il capitale nel pannello «Cerca la combinazione migliore» vedeva
// montepremi, quota modellata, concorrenza in banda, banda e scadenza — e niente che dicesse se quel
// mercato è vivo.
//
// ═══ QUESTO MODULO NON DECIDE NIENTE ════════════════════════════════════════════════════════════════
// Nessun parametro operativo è legato a questi numeri: non toccano la soglia di movimento, non toccano
// la profondità N, non entrano nel knapsack e non scartano nessun candidato. Servono a GUARDARE, in
// attesa di misurare se esiste davvero una correlazione fra velocità e frequenza dei fill. Legarli
// prima di averla misurata sarebbe esattamente il genere di scorciatoia che questo progetto evita.
//
// ═══ LE METRICHE, E PERCHÉ QUESTE ═══════════════════════════════════════════════════════════════════
//
// SCARTATA — «eventi websocket al minuto». Non è misurabile ONESTAMENTE da questa fonte. Il giornale
// campiona ogni 75s e registra `src:'ws'|'stale'`, che è un BOOLEANO: «almeno un evento negli ultimi
// 75s». Un mercato con un evento al minuto e uno con cento sono indistinguibili. Riportare un tasso
// vorrebbe dire inventare una precisione che il dato non ha. Misurarlo davvero richiederebbe un
// contatore per asset dentro agent34 — cioè una raccolta NUOVA, che il requisito 4 chiede di evitare.
//
// TENUTA — `silenzioPct`: la quota di campioni con `src:'stale'`, cioè in cui quell'asset non ha
// ricevuto NESSUN evento per almeno 75 secondi. È esattamente il numero che ha previsto l'incidente, ed
// è ciò che fa mordere il guard sul mid vecchio. Un mercato al 26% passa un quarto del tempo in uno
// stato in cui il motore, correttamente, si rifiuta di muovere un ordine.
//
// TENUTA — `movimentoCentsOra`: Σ|Δ mid| sulla finestra, in centesimi, riportato all'ora. È la strada
// che il mid percorre davvero. Predice il lavoro di riprezzo e il rischio di uscire dalla banda, ed è
// la grandezza che il requisito chiama «ampiezza media dello spostamento».
//
// TENUTA — `passiOra`: quante volte il mid CAMBIA, per ora. Due mercati possono percorrere gli stessi
// centesimi/ora con profili opposti — un salto solo contro un tremolio continuo — e per un maker sono
// due mondi diversi: il primo produce un riprezzo, il secondo ne produce venti. Il rapporto fra le due
// (centesimi per passo) dice quale dei due si ha davanti.
//
// SEMPRE ACCANTO — `campioni` e `coperturaOre`: una misura su nove campioni non vale come una su
// trecento, e chi legge deve poterlo vedere. Un mercato senza storico resta `null`: «non misurato» non
// è «immobile», e i due non devono poter finire nella stessa cella.
//
// ═══ MEMORIA — LEZIONE DEL 6 AGOSTO ═════════════════════════════════════════════════════════════════
// Il giornale cresce di ~9 MB l'ora (misurato: 53 MB in 5h45 su 114 mercati). Questa box è un 4 GB in
// cui `JSON.parse(readFileSync(...))` su file da centinaia di MB ha già chiamato l'OOM killer dieci
// volte in otto giorni. Quindi qui:
//   • si legge SOLO la coda che copre la finestra, con un tetto di byte dichiarato;
//   • si legge a blocchi, in avanti, e si tiene in memoria SOLO l'aggregato per mercato — mai le righe;
//   • la memoria è O(mercati), qualunque cosa faccia il file.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../safety/store');

const FINESTRA_ORE_DEFAULT = 6;
// Il tetto di lettura. A ~9 MB/h una finestra da 6 ore costa ~55 MB; 128 MB lascia margine per giornate
// più dense senza mai diventare una lettura illimitata. Se il tetto morde, la finestra effettiva si
// accorcia e `coperturaOre` lo dice — non si finge di aver misurato sei ore.
const TETTO_BYTE = 128 * 1024 * 1024;
const BLOCCO = 4 * 1024 * 1024;
// L'intervallo di campionamento del giornale (agent34 MID_HISTORY_INTERVAL_MS). Serve solo a spiegare
// cosa significa `src:'stale'`; non viene usato per dedurre tassi.
const PASSO_CAMPIONE_SEC = 75;
// Il risultato si riusa per qualche minuto: il pannello si riapre spesso e la misura cambia lentamente.
const CACHE_MS = 5 * 60_000;

let _cache = { at: 0, chiave: '', mappa: null };

const giornoUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const fileGiorno = (dir, g) => path.join(dir, `mid-history-${g}.jsonl`);

/**
 * Accumulatore per un mercato. Tiene SOLO numeri: nessuna riga sopravvive alla sua lettura.
 */
function nuovoAcc() {
  return {
    campioni: 0, stale: 0, passi: 0, movimento: 0, primoTs: null, ultimoTs: null, ultimoMid: null,
    // ── AGGIUNTI PER LE REGOLE DI PIAZZAMENTO (6 agosto 2026) ────────────────────────────────────
    // `movimento` e' la STRADA percorsa (Σ|Δmid|); il RANGE (max − min) e' un'altra cosa e le due non
    // si deducono l'una dall'altra: un mid che oscilla di un tick mille volte ha movimento enorme e
    // range minimo. Le regole di volatilita' chiedono il range, quindi il range si misura.
    midMin: null, midMax: null,
    // Lo spread bid/ask campione per campione: il giornale porta bestBid e bestAsk, quindi la media
    // mobile dello spread non ha bisogno di una raccolta nuova.
    spreadSomma: 0, spreadCampioni: 0, spreadUltimo: null, spreadUltimoTs: null,
    // ── LA LIQUIDITA' IN BANDA, PER LA REGOLA DEL PAVIMENTO ADATTIVO ─────────────────────────────
    // Il giornale porta gia' `bidDepthInBand` e `askDepthInBand` per campione: la liquidita' NORMALE
    // di un mercato si misura da qui, senza nessuna raccolta nuova. Serve a rispondere «quanto e'
    // profondo QUESTO mercato di solito», che e' l'unico modo di rendere un pavimento in dollari
    // confrontabile fra un mercato da $60.000 in banda e uno da $200.
    depthSomma: 0, depthCampioni: 0,
  };
}

function ingerisci(acc, r) {
  const ts = Date.parse(r.ts);
  if (!Number.isFinite(ts)) return;
  acc.campioni += 1;
  if (r.src === 'stale') acc.stale += 1;
  if (acc.primoTs == null || ts < acc.primoTs) acc.primoTs = ts;
  if (acc.ultimoTs == null || ts > acc.ultimoTs) acc.ultimoTs = ts;
  // ── LO SPREAD DI QUESTO CAMPIONE ────────────────────────────────────────────────────────────────
  // Indipendente dal mid: un campione puo' avere tocco leggibile e mid no, o viceversa. Contarli
  // insieme farebbe sparire meta' delle misure per l'assenza dell'altra.
  const bb = Number(r.bestBid);
  const ba = Number(r.bestAsk);
  if (Number.isFinite(bb) && Number.isFinite(ba) && ba > bb) {
    const sp = ba - bb;
    acc.spreadSomma += sp;
    acc.spreadCampioni += 1;
    if (acc.spreadUltimoTs == null || ts >= acc.spreadUltimoTs) { acc.spreadUltimo = sp; acc.spreadUltimoTs = ts; }
  }

  // La profondita' in banda dei DUE lati sommata: e' la liquidita' che compete davvero al maker.
  const bd = Number(r.bidDepthInBand);
  const ad = Number(r.askDepthInBand);
  if (Number.isFinite(bd) || Number.isFinite(ad)) {
    acc.depthSomma += (Number.isFinite(bd) ? bd : 0) + (Number.isFinite(ad) ? ad : 0);
    acc.depthCampioni += 1;
  }

  const mid = Number(r.adjMid);
  if (!Number.isFinite(mid)) return;              // un mid assente non è un mid fermo: non conta come passo
  if (acc.midMin == null || mid < acc.midMin) acc.midMin = mid;
  if (acc.midMax == null || mid > acc.midMax) acc.midMax = mid;
  if (acc.ultimoMid != null) {
    const d = Math.abs(mid - acc.ultimoMid);
    // Soglia sotto il decimo di tick minimo del venue: sotto di lì è rumore di arrotondamento del
    // giornale, non un movimento del book.
    if (d > 1e-6) { acc.passi += 1; acc.movimento += d; }
  }
  acc.ultimoMid = mid;
}

/**
 * Legge la CODA di un file di giornale e aggrega, senza mai tenere le righe.
 * @returns {number} byte effettivamente letti
 */
function leggiCoda(file, cutoffMs, accs, budgetByte, deps = {}) {
  const fsx = deps.fs || fs;
  let st;
  try { st = fsx.statSync(file); } catch { return 0; }
  if (!st.size) return 0;
  const da = Math.max(0, st.size - budgetByte);
  let fd;
  let letti = 0;
  try {
    fd = fsx.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(BLOCCO);
    let pos = da;
    let coda = '';
    let primaRigaScartata = da === 0;   // se si parte dall'inizio non c'è nessuna riga tronca da buttare
    while (pos < st.size) {
      const n = fsx.readSync(fd, buf, 0, Math.min(BLOCCO, st.size - pos), pos);
      if (n <= 0) break;
      pos += n; letti += n;
      const testo = coda + buf.toString('utf8', 0, n);
      const righe = testo.split('\n');
      coda = righe.pop();               // può essere una riga a metà: mai parsata qui
      for (const riga of righe) {
        if (!primaRigaScartata) { primaRigaScartata = true; continue; }  // troncata dal seek
        if (!riga) continue;
        let r; try { r = JSON.parse(riga); } catch { continue; }
        if (!r || !r.marketId || !r.ts) continue;
        if (Date.parse(r.ts) < cutoffMs) continue;
        if (!accs.has(r.marketId)) accs.set(r.marketId, nuovoAcc());
        ingerisci(accs.get(r.marketId), r);
      }
    }
  } catch { /* una lettura fallita restituisce ciò che si è già aggregato */ }
  finally { if (fd !== undefined) { try { fsx.closeSync(fd); } catch { /* ignore */ } } }
  return letti;
}

/**
 * La velocità di ogni mercato con storico nella finestra.
 *
 * @param {object} opts
 *   windowHours  finestra in ore (default 6)
 *   now          epoch ms (iniettabile)
 *   dir          cartella dei giornali (iniettabile)
 *   noCache      salta la cache (per i test)
 * @returns {{at:string, finestraOre:number, mercati:number, byteLetti:number,
 *            passoCampioneSec:number, per:Map<string,object>}}
 */
function leggiVelocita(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const finestraOre = Number.isFinite(opts.windowHours) && opts.windowHours > 0 ? opts.windowHours : FINESTRA_ORE_DEFAULT;
  const dir = opts.dir || DATA_DIR;
  const chiave = `${dir}|${finestraOre}`;
  if (!opts.noCache && _cache.mappa && _cache.chiave === chiave && now - _cache.at < CACHE_MS) {
    return _cache.mappa;
  }

  const cutoff = now - finestraOre * 3_600_000;
  const accs = new Map();
  let byteLetti = 0;
  // I giorni UTC toccati dalla finestra, dal più vecchio al più recente: una finestra che scavalca la
  // mezzanotte deve leggere due file, altrimenti alle 00:30 la misura sarebbe fatta su mezz'ora.
  const giorni = [];
  for (let t = cutoff; ; t += 86_400_000) {
    const g = giornoUtc(t);
    if (!giorni.includes(g)) giorni.push(g);
    if (g === giornoUtc(now)) break;
    if (giorni.length > 3) break;      // guardia: una finestra assurda non deve poter leggere l'archivio
  }
  let budget = TETTO_BYTE;
  for (const g of giorni.reverse()) {  // dal più recente: se il tetto morde, si perde il passato, non il presente
    if (budget <= 0) break;
    const letti = leggiCoda(fileGiorno(dir, g), cutoff, accs, budget, opts);
    byteLetti += letti; budget -= letti;
  }

  const per = new Map();
  for (const [marketId, a] of accs) {
    // Una finestra con meno di due campioni non permette di parlare di movimento: si dichiara e basta.
    const coperturaOre = (a.primoTs != null && a.ultimoTs != null && a.ultimoTs > a.primoTs)
      ? (a.ultimoTs - a.primoTs) / 3_600_000 : 0;
    const misurabile = a.campioni >= 2 && coperturaOre > 0;
    per.set(marketId, {
      campioni: a.campioni,
      coperturaOre: +coperturaOre.toFixed(2),
      // % di campioni senza un solo evento websocket nei 75s precedenti.
      silenzioPct: a.campioni > 0 ? +((a.stale / a.campioni) * 100).toFixed(1) : null,
      // centesimi percorsi dal mid, per ora.
      movimentoCentsOra: misurabile ? +((a.movimento * 100) / coperturaOre).toFixed(2) : null,
      // quante volte il mid cambia, per ora.
      passiOra: misurabile ? +(a.passi / coperturaOre).toFixed(1) : null,
      // centesimi per passo: distingue un salto solo da un tremolio continuo. null quando non ci sono passi.
      centsPerPasso: misurabile && a.passi > 0 ? +((a.movimento * 100) / a.passi).toFixed(2) : null,
    });
  }

  const out = {
    at: new Date(now).toISOString(),
    finestraOre,
    mercati: per.size,
    byteLetti,
    passoCampioneSec: PASSO_CAMPIONE_SEC,
    per,
  };
  if (!opts.noCache) _cache = { at: now, chiave, mappa: out };
  return out;
}

/**
 * L'etichetta di lettura — descrive UNA cosa sola: la CONTINUITÀ DEL FEED su quel mercato.
 *
 * Non è un voto, non è una raccomandazione e non riassume la velocità nel suo insieme. Riassume
 * `silenzioPct` in due parole perché una colonna di percentuali non si scorre, e nient'altro: il
 * movimento sta accanto come numero suo, perché le due cose sono indipendenti e vanno lette insieme.
 * Fra i mercati veri misurati il 6 agosto ci sono entrambi i casi estremi — uno con feed continuo e mid
 * completamente immobile (0% silenzio, 0¢/h) e uno silenzioso che però si muove parecchio (MI-10: 26%
 * di silenzio e 6,7¢/h) — e un'etichetta sola non può descriverli tutti e due.
 *
 * Le soglie vengono dalla diagnosi del 6 agosto: il resto del board sta al 2%, i mercati che ci sono
 * costati l'incidente stavano fra il 10% e il 26%.
 *
 * Nessun ramo di codice operativo legge questa etichetta: si veda il commento in testa al file.
 */
function etichettaVelocita(v) {
  if (!v || v.silenzioPct == null) return { chiave: 'ignota', testo: 'non misurato' };
  if (v.silenzioPct >= 15) return { chiave: 'intermittente', testo: 'feed intermittente' };
  if (v.silenzioPct >= 5) return { chiave: 'a-tratti', testo: 'feed a tratti' };
  return { chiave: 'continuo', testo: 'feed continuo' };
}

/**
 * LA FINESTRA DI UN MERCATO SOLO, senza cache e senza leggere l'intero board.
 *
 * ═══ PERCHÉ NON `leggiVelocita` ═══════════════════════════════════════════════════════════════════
 * `leggiVelocita` aggrega TUTTI i mercati su una finestra di ore e tiene il risultato in cache per 5
 * minuti. Va benissimo per un pannello che si riapre spesso. Non va per le regole di piazzamento:
 *   · la finestra Risk e' di 5 MINUTI, e una cache da 5 minuti potrebbe restituire una misura che
 *     copre un intervallo ormai passato per intero — cioe' rispondere sul nulla;
 *   · leggere l'intero board a ogni giro del ciclo da 5s costa quanto tutto il resto messo insieme.
 *
 * Quindi: stesse funzioni di lettura (`leggiCoda`, `ingerisci`, gli stessi file), un mercato solo,
 * nessuna cache. Non e' una seconda implementazione: e' la stessa, chiamata con un altro perimetro.
 *
 * ═══ ONESTA' SULLA RISOLUZIONE ════════════════════════════════════════════════════════════════════
 * Il giornale campiona ogni ~75 secondi. Una finestra da 5 minuti contiene quindi ~4 campioni, e il
 * range misurato su 4 punti e' una stima grossolana: puo' solo SOTTOSTIMARE il movimento vero (fra due
 * campioni il mid puo' essere andato e tornato). `campioni` viaggia nel risultato proprio perche' chi
 * decide sappia su quanti punti sta decidendo, e `sufficiente` dice se sono abbastanza.
 *
 * @param {object} opts
 *   marketId        il mercato (obbligatorio)
 *   windowMinutes   ampiezza della finestra in minuti
 *   minCampioni     sotto questo numero la misura si dichiara NON sufficiente (default 2: sotto due
 *                   punti un range non esiste, non e' zero)
 *   now, dir, fs    iniettabili per i test
 * @returns {{leggibile:boolean, marketId:string, campioni:number, sufficiente:boolean,
 *            rangeMid:number|null, midMin:number|null, midMax:number|null,
 *            spreadMedio:number|null, spreadUltimo:number|null, spreadCampioni:number,
 *            coperturaMin:number|null, motivo:string|null}}
 */
function leggiFinestraMercato(opts = {}) {
  const marketId = typeof opts.marketId === 'string' ? opts.marketId.trim() : '';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMinutes = Number.isFinite(opts.windowMinutes) && opts.windowMinutes > 0 ? opts.windowMinutes : 60;
  const minCampioni = Number.isFinite(opts.minCampioni) && opts.minCampioni > 0 ? opts.minCampioni : 2;
  const dir = opts.dir || DATA_DIR;
  const vuoto = (motivo) => ({
    leggibile: false, marketId, campioni: 0, sufficiente: false,
    rangeMid: null, midMin: null, midMax: null,
    spreadMedio: null, spreadUltimo: null, spreadCampioni: 0,
    depthMedia: null, depthCampioni: 0,
    coperturaMin: null, motivo,
  });
  if (!marketId) return vuoto('marketId assente');

  const cutoff = now - windowMinutes * 60_000;
  const giorni = [];
  for (let t = cutoff; ; t += 86_400_000) {
    const g = giornoUtc(t);
    if (!giorni.includes(g)) giorni.push(g);
    if (g === giornoUtc(now)) break;
    if (giorni.length > 3) break;
  }

  const accs = new Map();
  let budget = TETTO_BYTE;
  for (const g of giorni.reverse()) {
    if (budget <= 0) break;
    budget -= leggiCoda(fileGiorno(dir, g), cutoff, accs, budget, opts);
  }

  const a = accs.get(marketId);
  if (!a || a.campioni === 0) return vuoto('nessun campione per questo mercato nella finestra');

  const copertura = (a.primoTs != null && a.ultimoTs != null) ? (a.ultimoTs - a.primoTs) / 60_000 : null;
  return {
    leggibile: true, marketId,
    campioni: a.campioni,
    // «Sufficiente» e' una dichiarazione, non una soglia nascosta: chi legge decide cosa farne, e le
    // regole Safe/Risk trattano l'insufficienza come «non nervoso», mai come «bloccato».
    sufficiente: a.campioni >= minCampioni && a.midMin != null && a.midMax != null,
    rangeMid: (a.midMin != null && a.midMax != null) ? +(a.midMax - a.midMin).toFixed(6) : null,
    midMin: a.midMin, midMax: a.midMax,
    spreadMedio: a.spreadCampioni > 0 ? +(a.spreadSomma / a.spreadCampioni).toFixed(6) : null,
    spreadUltimo: a.spreadUltimo != null ? +a.spreadUltimo.toFixed(6) : null,
    spreadCampioni: a.spreadCampioni,
    /** Media della profondita' in banda (bid+ask) sulla finestra, in SHARE. */
    depthMedia: a.depthCampioni > 0 ? +(a.depthSomma / a.depthCampioni).toFixed(4) : null,
    depthCampioni: a.depthCampioni,
    coperturaMin: copertura != null ? +copertura.toFixed(2) : null,
    motivo: null,
  };
}

module.exports = {
  leggiVelocita, leggiFinestraMercato, etichettaVelocita, nuovoAcc, ingerisci,
  FINESTRA_ORE_DEFAULT, TETTO_BYTE, PASSO_CAMPIONE_SEC, CACHE_MS,
};

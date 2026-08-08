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

// ── QUANTO SI LEGGE DAVVERO, E PERCHÉ NON PIÙ IL TETTO (8 agosto 2026) ──────────────────────────────
// Il TETTO qui sopra è un limite MASSIMO di sicurezza, ed è dimensionato per una finestra da sei ore.
// Fino a oggi era anche l'unica cosa che decideva il punto di seek: `da = size − TETTO`. Con un giornale
// più piccolo del tetto quel conto dà ZERO, cioè «leggi tutto dall'inizio» — anche a chi chiede quindici
// minuti.
//
// Misurato: agent40 chiede 15 minuti una volta per mercato per ciclo. Con il giornale a 77 MB ogni
// chiamata leggeva e faceva `JSON.parse` di 61.746 righe per estrarne 12, in 524 ms; per tredici mercati
// erano 6,8 s di CPU dentro un ciclo da 5 s — cioè il 136% di un core, che cresceva con il file e si
// azzerava a mezzanotte. Quindici minuti di giornale sono ~1,7 MB.
//
// Adesso il budget si dimensiona sulla FINESTRA CHIESTA. Il tasso di scrittura è misurato: 77,4 MB in
// 11,57 h l'8 agosto 2026 = 6,7 MB/h, e l'intestazione ne registra 9 MB/h il 6 agosto con 114 mercati.
// 128 KB/min sono 7,7 MB/h, cioè sopra la misura di oggi e nell'ordine di grandezza di entrambe.
const BYTE_AL_MINUTO = 128 * 1024;
// Il margine sul tasso stimato. ×2 copre un raddoppio del ritmo di scrittura (più mercati sottoscritti,
// o un campionamento più fitto) senza che la finestra si accorci. Non è l'unica difesa — vedi il
// controllo di copertura qui sotto, che è quello che rende il margine una ottimizzazione e non una
// scommessa.
const MARGINE_FINESTRA = 2;
// Sotto questo non si scende: un blocco di lettura è 4 MB, e chiedere meno di un MB non fa risparmiare
// niente di misurabile mentre aumenta la probabilità di dover riprovare.
const MINIMO_BYTE = 1024 * 1024;
// Quante volte si riprova allargando, se il budget non è bastato a coprire la finestra.
const TENTATIVI_MAX = 4;

/**
 * Il budget di byte per una finestra di `minuti`. Mai sopra il tetto di sicurezza, mai sotto il minimo.
 */
function budgetPerFinestra(minuti) {
  const m = Number.isFinite(minuti) && minuti > 0 ? minuti : FINESTRA_ORE_DEFAULT * 60;
  return Math.min(TETTO_BYTE, Math.max(MINIMO_BYTE, Math.ceil(m * BYTE_AL_MINUTO * MARGINE_FINESTRA)));
}
// L'intervallo di campionamento del giornale (agent34 MID_HISTORY_INTERVAL_MS). Serve solo a spiegare
// cosa significa `src:'stale'`; non viene usato per dedurre tassi.
const PASSO_CAMPIONE_SEC = 75;
// Il risultato si riusa per qualche minuto: il pannello si riapre spesso e la misura cambia lentamente.
const CACHE_MS = 5 * 60_000;

let _cache = { at: 0, chiave: '', mappa: null };

const giornoUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const fileGiorno = (dir, g) => path.join(dir, `mid-history-${g}.jsonl`);

/**
 * I giorni UTC toccati dalla finestra, DAL PIÙ RECENTE al più vecchio — che è l'ordine in cui vanno
 * letti: se il budget morde, si perde il passato, non il presente. Una finestra che scavalca la
 * mezzanotte deve leggere due file, altrimenti alle 00:30 la misura sarebbe fatta su mezz'ora.
 * Era scritto due volte, identico, in `leggiVelocita` e in `leggiFinestraMercato`.
 */
function giorniDellaFinestra(cutoffMs, nowMs) {
  const giorni = [];
  for (let t = cutoffMs; ; t += 86_400_000) {
    const g = giornoUtc(t);
    if (!giorni.includes(g)) giorni.push(g);
    if (g === giornoUtc(nowMs)) break;
    if (giorni.length > 3) break;      // guardia: una finestra assurda non deve poter leggere l'archivio
  }
  return giorni.reverse();
}

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
 *
 * Restituisce anche DUE fatti che servono a sapere se il budget è bastato, e che prima non uscivano:
 *   · `daZero`        si è partiti dall'inizio del file, quindi più indietro di così non si va;
 *   · `primoTsVisto`  l'istante della riga più VECCHIA incontrata nel tratto letto, PRIMA del filtro
 *                     sul cutoff. Se è più recente del cutoff, il tratto non arriva fin dove serve —
 *                     ed è l'unico modo di accorgersene senza fidarsi della stima del tasso.
 * @returns {{letti:number, daZero:boolean, primoTsVisto:number|null}}
 */
function leggiCoda(file, cutoffMs, accs, budgetByte, deps = {}) {
  const fsx = deps.fs || fs;
  let st;
  try { st = fsx.statSync(file); } catch { return { letti: 0, daZero: true, primoTsVisto: null }; }
  if (!st.size) return { letti: 0, daZero: true, primoTsVisto: null };
  const da = Math.max(0, st.size - budgetByte);
  let fd;
  let letti = 0;
  let primoTsVisto = null;
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
        const ts = Date.parse(r.ts);
        // Si registra l'istante PRIMA del filtro: serve a sapere fin dove il tratto letto arriva
        // davvero, non fin dove arrivano le righe che hanno superato il cutoff.
        if (Number.isFinite(ts) && (primoTsVisto == null || ts < primoTsVisto)) primoTsVisto = ts;
        if (ts < cutoffMs) continue;
        if (!accs.has(r.marketId)) accs.set(r.marketId, nuovoAcc());
        ingerisci(accs.get(r.marketId), r);
      }
    }
  } catch { /* una lettura fallita restituisce ciò che si è già aggregato */ }
  finally { if (fd !== undefined) { try { fsx.closeSync(fd); } catch { /* ignore */ } } }
  return { letti, daZero: da === 0, primoTsVisto };
}

/**
 * ── L'AGGREGATO DI UNA FINESTRA, LETTO UNA VOLTA SOLA ──────────────────────────────────────────────
 *
 * È il cuore condiviso: `leggiVelocita` e `leggiFinestraTutti` passano di qui, quindi esiste UN solo
 * posto che decide quanto si legge e quando ci si ferma.
 *
 * ═══ IL CONTROLLO DI COPERTURA, E PERCHÉ IL MARGINE NON È UNA SCOMMESSA ═══════════════════════════
 * Il budget nasce da una STIMA del tasso di scrittura, e una stima può sbagliare — un giorno con il
 * doppio dei mercati sottoscritti scrive il doppio. Se ci si fermasse lì, la finestra si accorcerebbe
 * in silenzio e la misura direbbe «quindici minuti» avendone visti sette.
 *
 * Quindi dopo ogni tentativo si guarda la riga più vecchia INCONTRATA: se è più recente del cutoff e
 * non si è partiti dall'inizio del file, il tratto non copriva la finestra — si allarga di quattro
 * volte e si rilegge. Al massimo `TENTATIVI_MAX` volte, e mai oltre il tetto. Il caso normale è UN
 * tentativo; il secondo esiste perché la correttezza non dipenda dalla stima.
 *
 * @returns {{accs:Map, byteLetti:number, tentativi:number, coperto:boolean, budgetUsato:number}}
 */
function aggregaFinestra({ cutoffMs, giorni, dir, minuti, opts = {} }) {
  let budget = budgetPerFinestra(minuti);
  let accs = new Map();
  let byteLetti = 0;
  let tentativi = 0;
  let coperto = false;

  for (let i = 0; i < TENTATIVI_MAX; i += 1) {
    tentativi += 1;
    accs = new Map();
    byteLetti = 0;
    let residuo = budget;
    let daZeroOvunque = true;
    let piuVecchio = null;
    // Dal più recente: se il budget morde, si perde il passato, non il presente.
    for (const g of giorni) {
      if (residuo <= 0) { daZeroOvunque = false; break; }
      const r = leggiCoda(fileGiorno(dir, g), cutoffMs, accs, residuo, opts);
      byteLetti += r.letti; residuo -= r.letti;
      if (!r.daZero) daZeroOvunque = false;
      if (r.primoTsVisto != null && (piuVecchio == null || r.primoTsVisto < piuVecchio)) piuVecchio = r.primoTsVisto;
    }
    // Coperto se il tratto letto arriva PRIMA del cutoff, oppure se non c'era altro da leggere.
    coperto = daZeroOvunque || (piuVecchio != null && piuVecchio <= cutoffMs);
    if (coperto || budget >= TETTO_BYTE) break;
    budget = Math.min(TETTO_BYTE, budget * 4);
  }
  return { accs, byteLetti, tentativi, coperto, budgetUsato: budget };
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
  // Stesso aggregatore di `leggiFinestraTutti`: un solo posto decide quanto si legge. Il budget adesso
  // nasce dalla finestra chiesta invece che dal tetto — per sei ore vale ~92 MB contro i 128 di prima,
  // quindi questo chiamante legge quanto prima o meno, mai di più, e il controllo di copertura
  // garantisce che la finestra resti quella dichiarata.
  const { accs, byteLetti } = aggregaFinestra({
    cutoffMs: cutoff, giorni: giorniDellaFinestra(cutoff, now), dir, minuti: finestraOre * 60, opts,
  });

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
/** La forma che questo modulo restituisce quando NON ha una misura. Una sola definizione, così la
 *  variante per un mercato e quella in blocco non possono descrivere l'assenza in due modi diversi. */
function finestraVuota(marketId, motivo) {
  return {
    leggibile: false, marketId, campioni: 0, sufficiente: false,
    rangeMid: null, midMin: null, midMax: null,
    spreadMedio: null, spreadUltimo: null, spreadCampioni: 0,
    depthMedia: null, depthCampioni: 0,
    coperturaMin: null, motivo,
  };
}

/** La proiezione di UN accumulatore nella misura pubblicata. È l'unico posto in cui quei campi nascono. */
function proiettaFinestra(a, marketId, minCampioni) {
  if (!a || a.campioni === 0) return finestraVuota(marketId, 'nessun campione per questo mercato nella finestra');
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

/**
 * ── LA FINESTRA DI TUTTI I MERCATI, CON UNA LETTURA SOLA (8 agosto 2026) ───────────────────────────
 *
 * Il difetto che chiude, misurato. `leggiFinestraMercato` accumula in `accs` OGNI mercato che incontra
 * nel tratto letto — non solo quello chiesto — e poi ne proietta uno, buttando il resto. agent40 la
 * chiamava una volta per mercato per ciclo: tredici letture identiche del file, tredici mappe complete
 * costruite e dodici tredicesimi buttati ogni volta.
 *
 * Questa funzione fa quel lavoro UNA volta e restituisce la mappa intera. Chi ha bisogno di un mercato
 * solo continua a chiamare `leggiFinestraMercato`, che ora è una proiezione di questa: nessuna seconda
 * implementazione, e per costruzione lo stesso identico numero.
 *
 * NESSUNA CACHE, deliberatamente — la stessa ragione per cui non la usa `leggiFinestraMercato`: la
 * finestra è di minuti, e una cache da minuti risponderebbe su un intervallo ormai passato.
 *
 * @returns {{per:Map<string,object>, byteLetti:number, tentativi:number, coperto:boolean,
 *            finestraMin:number, mercati:number}}
 */
function leggiFinestraTutti(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMinutes = Number.isFinite(opts.windowMinutes) && opts.windowMinutes > 0 ? opts.windowMinutes : 60;
  const minCampioni = Number.isFinite(opts.minCampioni) && opts.minCampioni > 0 ? opts.minCampioni : 2;
  const dir = opts.dir || DATA_DIR;
  const cutoff = now - windowMinutes * 60_000;

  const { accs, byteLetti, tentativi, coperto } = aggregaFinestra({
    cutoffMs: cutoff, giorni: giorniDellaFinestra(cutoff, now), dir, minuti: windowMinutes, opts,
  });

  const per = new Map();
  for (const [marketId, a] of accs) per.set(marketId, proiettaFinestra(a, marketId, minCampioni));
  return { per, byteLetti, tentativi, coperto, finestraMin: windowMinutes, mercati: per.size };
}

/**
 * LA FINESTRA DI UN MERCATO SOLO.
 *
 * Dall'8 agosto 2026 è una PROIEZIONE di `leggiFinestraTutti`: stessa lettura, stessa aggregazione,
 * stessa funzione di proiezione. Il risultato è identico a quello di prima campo per campo — quello che
 * cambia è che chi deve interrogare tredici mercati non è più costretto a rileggere tredici volte.
 *
 * @param {object} opts
 *   marketId        il mercato (obbligatorio)
 *   windowMinutes   ampiezza della finestra in minuti
 *   minCampioni     sotto questo numero la misura si dichiara NON sufficiente (default 2: sotto due
 *                   punti un range non esiste, non e' zero)
 *   now, dir, fs    iniettabili per i test
 */
function leggiFinestraMercato(opts = {}) {
  const marketId = typeof opts.marketId === 'string' ? opts.marketId.trim() : '';
  if (!marketId) return finestraVuota(marketId, 'marketId assente');
  const tutti = leggiFinestraTutti(opts);
  const m = tutti.per.get(marketId);
  return m || finestraVuota(marketId, 'nessun campione per questo mercato nella finestra');
}

module.exports = {
  leggiVelocita, leggiFinestraMercato, leggiFinestraTutti, etichettaVelocita,
  nuovoAcc, ingerisci, finestraVuota, proiettaFinestra, budgetPerFinestra, aggregaFinestra,
  FINESTRA_ORE_DEFAULT, TETTO_BYTE, PASSO_CAMPIONE_SEC, CACHE_MS,
  BYTE_AL_MINUTO, MARGINE_FINESTRA, MINIMO_BYTE, TENTATIVI_MAX,
};

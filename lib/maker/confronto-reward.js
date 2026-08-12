'use strict';
// lib/maker/confronto-reward.js — LA STIMA CONTRO IL DATO VERO, UNA RIGA PER GIORNATA.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Il bot dice quanto sta maturando. Nessuno gliel'ha mai chiesto conto. Una stima che non viene mai
// confrontata col consuntivo non è una stima: è una convinzione, e può restare sbagliata di un ordine
// di grandezza per settimane senza che niente lo segnali.
//
// ═══ DUE MOMENTI, DUE SCRITTURE SULLA STESSA RIGA ════════════════════════════════════════════════════
//   23:55 UTC — la giornata sta per chiudere: si fotografa la STIMA finale (totale + per mercato).
//   00:20 UTC — la giornata è chiusa: si chiede al venue il CONSUNTIVO e lo si scrive accanto.
//
// Il ritardo fra i due non è un dettaglio: il venue consolida dopo la mezzanotte, e chiedere alle 23:55
// darebbe una giornata incompleta. Se alle 00:20 non è pronto si riprova alle 00:40 e alle 01:00, poi
// si smette e la riga resta marcata «non disponibile» — che è un esito, non un buco.
//
// ═══ «NON DISPONIBILE» NON È «ZERO» ══════════════════════════════════════════════════════════════════
// La regola che rende utile tutto il resto. Un venue in ritardo che venisse scritto come 0 farebbe
// apparire la stima sbagliata del 100% ogni notte, e dopo tre notti nessuno guarderebbe più il
// confronto. Lo scarto si calcola SOLO quando il reale c'è davvero.
//
// ═══ LA DECISIONE ORARIA È PURA ══════════════════════════════════════════════════════════════════════
// `compitiDovuti` non legge l'orologio: lo riceve. Così «alle 23:55 scatta la cattura» si prova in un
// test in un millisecondo invece di aspettare la notte, ed è anche l'unico modo di verificare il
// comportamento sul confine dei minuti senza starci davanti.

const fs = require('fs');
const path = require('path');
// La stessa risoluzione di `data/` degli altri moduli maker: questo file lo carica agent40 come node
// semplice E la dashboard dentro il bundle di Next, dove `__dirname` è `.next/server/…`.
const { DATA_DIR } = require('../safety/store');

const CONFRONTO_FILE = path.join(DATA_DIR, 'confronto-reward.json');
/** Quante giornate si tengono. Due mesi bastano a vedere una deriva sistematica. */
const GIORNI_TENUTI = 60;

// ── LA SOGLIA DELL'AVVISO, E PERCHÉ QUESTI NUMERI ────────────────────────────────────────────────────
// La domanda è «la stima è sbagliata in modo SISTEMATICO?», non «ieri ci ha preso?». Una stima di
// reward maker è una run-rate lorda con correzioni dichiarate (vedi lib/rewards/realistic-estimate.js);
// il rumore di una singola giornata è dominato da cose che nessun modello promette di indovinare —
// quanto tempo l'ordine è stato davvero in banda, quanti riprezzi, quanta concorrenza è arrivata nel
// pomeriggio. Uno scarto del 20% su un giorno solo è dentro quel rumore.
//
// SOGLIA_SCARTO_PCT = 30 — sotto il 30% non si grida. È volutamente sopra il rumore quotidiano: un
//   avviso che scatta ogni settimana viene ignorato entro un mese, e allora tanto vale non averlo.
// OSSERVAZIONI_MINIME = 5 — cinque giornate CONFRONTABILI (stima presente e consuntivo attribuito).
//   Meno di così e si starebbe leggendo un outlier: bastano un giorno di venue in ritardo e uno di
//   mercato risolto a metà giornata per produrre due scarti enormi che non dicono niente sul modello.
// CONCORDANZA_MINIMA = 0,8 — almeno l'80% delle giornate deve sbagliare NELLO STESSO VERSO. Una stima
//   che oscilla ±40% attorno al vero è imprecisa; una che sbaglia +40% ogni volta è TARATA MALE, ed è
//   solo la seconda che si corregge cambiando il modello. L'avviso serve alla seconda.
//
// La misura centrale è la MEDIANA degli scarti percentuali, non la media: una giornata con consuntivo
// quasi zero produce una percentuale enorme, e una media la lascerebbe decidere da sola.
//
// NON CORREGGE NIENTE. Questa fase segnala e basta: cambiare la stima in automatico sulla scorta di
// cinque giornate significherebbe inseguire il rumore con il capitale vero. La correzione, se servirà,
// è una decisione dell'operatore su un dato che adesso finalmente esiste.
const SOGLIA_SCARTO_PCT = Number(process.env.CONFRONTO_SOGLIA_PCT || 30);
const OSSERVAZIONI_MINIME = Number(process.env.CONFRONTO_OSSERVAZIONI_MINIME || 5);
const CONCORDANZA_MINIMA = 0.8;

/** L'orario UTC in cui si fotografa la stima della giornata che sta chiudendo. */
const ORA_STIMA = { h: 23, m: 55 };
/** Gli orari UTC in cui si chiede il consuntivo: il primo tentativo e i due ritenta. */
const ORE_REALE = [{ h: 0, m: 20 }, { h: 0, m: 40 }, { h: 1, m: 0 }];
/** Oltre questo numero di tentativi la giornata si marca «non disponibile» e non si insiste. */
const TENTATIVI_MAX = ORE_REALE.length;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const giornoUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Il giorno UTC precedente a quello di `ms`. È la giornata di cui si chiede il consuntivo dopo mezzanotte. */
const giornoPrecedente = (ms) => new Date(ms - 86_400_000).toISOString().slice(0, 10);

/**
 * QUALI COMPITI SONO DOVUTI ADESSO. Pura: l'orologio arriva da fuori.
 *
 * La finestra è di `toleranzaMin` minuti DOPO l'orario: il ciclo di agent40 gira ogni 5 secondi, ma un
 * riavvio o una pausa possono farlo saltare l'istante esatto. Senza tolleranza un riavvio alle 23:54:58
 * farebbe perdere la fotografia di quella giornata — e una giornata persa non si recupera.
 *
 * L'idempotenza NON sta qui: sta nel file. `compitiDovuti` dice «sarebbe l'ora», e chi scrive controlla
 * se per quella data ha già fatto. Tenere le due cose separate è ciò che permette di provarle da sole.
 *
 * @returns {{stima:boolean, reale:boolean, giornoStima:string, giornoReale:string, tentativo:number|null}}
 */
function compitiDovuti({ now = Date.now(), toleranzaMin = 4 } = {}) {
  const d = new Date(now);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const dentro = (o) => h === o.h && m >= o.m && m < o.m + toleranzaMin;

  const stima = dentro(ORA_STIMA);
  let tentativo = null;
  for (let i = 0; i < ORE_REALE.length; i++) if (dentro(ORE_REALE[i])) { tentativo = i + 1; break; }

  return {
    stima,
    reale: tentativo != null,
    tentativo,
    // Alle 23:55 la giornata che chiude è QUELLA CORRENTE; dopo mezzanotte è quella PRECEDENTE.
    giornoStima: giornoUtc(now),
    giornoReale: giornoPrecedente(now),
  };
}

// ══ IL RECUPERO A RITROSO (12 agosto 2026) ══════════════════════════════════════════════════════════
// `compitiDovuti` propone UNA giornata sola — quella di ieri — e tre tentativi ravvicinati. Se in quella
// finestra il consuntivo non c'è, la giornata resta senza consuntivo PER SEMPRE: nessuno ci torna.
//
// ⚠ E LA FINESTRA È PROPRIO QUELLA IN CUI IL DATO NON C'È ANCORA. I pagamenti reward arrivano alle
// ~00:00:0X UTC del giorno DOPO quello di competenza, e la finestra di pagamento si dichiara chiusa sei
// ore più tardi. I tre tentativi cadono nella notte, quindi la risposta legittima è «non ancora» — e
// dopo i tre tentativi si smette di chiedere. Misurato: **sei giornate registrate, ZERO con consuntivo**,
// mentre il registro attività pubblico li contiene tutti e quattro i pagamenti.
//
// Il dato è RECUPERABILE: la fonte è `data-api /activity?type=REWARD`, che restituisce lo storico
// completo del funder senza credenziali. Quindi non serve una seconda fonte, serve solo tornare a
// chiedere. Questa funzione dice QUALI giornate hanno ancora senso da chiedere.
//
// ═══ FINO A DOVE INDIETRO, E PERCHÉ NON «SEMPRE» ════════════════════════════════════════════════════
// `MAX_RECUPERO_GIORNI = 30`: il registro attività è paginato e il lettore ne chiede un numero finito
// di righe, quindi oltre un certo orizzonte la risposta smetterebbe di contenere il pagamento e uno zero
// diventerebbe indistinguibile da «troppo vecchio per essere visto». Trenta giorni stanno larghi dentro
// quel limite e coprono qualunque fermo realistico del bot.

const MAX_RECUPERO_GIORNI = 30;

/**
 * LE GIORNATE ANCORA DA CONSUNTIVARE. Pura: riceve il registro già letto.
 *
 * Si esclude la giornata CORRENTE e quella di ieri se la sua finestra di pagamento non è ancora chiusa:
 * chiederle produrrebbe lo stesso «non ancora» che ha creato il problema.
 *
 * @returns {string[]} giornate 'YYYY-MM-DD', dalla più vecchia alla più recente
 */
function giorniDaRecuperare({ giorni = null, now = Date.now(), maxGiorni = MAX_RECUPERO_GIORNI,
  finestraH = 6 } = {}) {
  const righe = Array.isArray(giorni) ? giorni : [];
  const oggi = giornoUtc(now);
  // Ieri si chiede solo se la sua finestra di pagamento è chiusa: il pagamento arriva a mezzanotte del
  // giorno dopo, più `finestraH` ore di margine.
  const ieri = giornoPrecedente(now);
  const chiusuraIeri = Date.parse(`${oggi}T00:00:00.000Z`) + finestraH * 3_600_000;
  const ieriPronto = now >= chiusuraIeri;

  const out = [];
  for (const r of righe) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.giorno || ''))) continue;
    // Già consuntivata: non si richiede. `realeUsd` a 0 È un consuntivo — «zero incassato» è un fatto.
    if (r.realeUsd != null) continue;
    if (r.giorno === oggi) continue;
    if (r.giorno === ieri && !ieriPronto) continue;
    const eta = (Date.parse(`${oggi}T00:00:00.000Z`) - Date.parse(`${r.giorno}T00:00:00.000Z`)) / 86_400_000;
    if (!Number.isFinite(eta) || eta > maxGiorni) continue;
    out.push(r.giorno);
  }
  return out.sort();
}

/** Lo scarto fra stima e reale. `null` ovunque quando il reale non c'è: non si divide per una speranza. */
function scarto({ stimaUsd = null, realeUsd = null } = {}) {
  if (!fin(stimaUsd) || !fin(realeUsd)) {
    return { assolutoUsd: null, percentuale: null, direzione: null };
  }
  const assoluto = +(stimaUsd - realeUsd).toFixed(6);
  // La percentuale è sul REALE, che è il termine di paragone vero. Con reale 0 non esiste una
  // percentuale: dividere darebbe Infinity, e Infinity in una tabella è peggio di un trattino.
  const perc = realeUsd !== 0 ? +((assoluto / Math.abs(realeUsd)) * 100).toFixed(2) : null;
  return {
    assolutoUsd: assoluto,
    percentuale: perc,
    direzione: assoluto > 0 ? 'sovrastima' : (assoluto < 0 ? 'sottostima' : 'esatta'),
  };
}

/**
 * LO SCARTO MERCATO PER MERCATO. La stima del bot è già scomposta (`stimaPerMercato`) e il consuntivo
 * del venue anche (`realePerMercato`): unirli è l'unico modo di distinguere «la stima è tarata male»
 * da «UN mercato si è comportato in modo imprevisto». Un totale che torna può nascondere due errori
 * che si compensano.
 *
 * Un mercato presente da una parte sola non produce uno scarto — produce una RIGA con l'altra metà a
 * null e il motivo. Stimato-e-non-incassato e incassato-senza-stima sono due diagnosi diverse, ed
 * entrambe sono informazioni.
 */
function scartoPerMercato({ stimaPerMercato = null, realePerMercato = null } = {}) {
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const stime = new Map();
  for (const s of (Array.isArray(stimaPerMercato) ? stimaPerMercato : [])) {
    const id = norm(s && s.marketId);
    if (!id) continue;
    stime.set(id, { titolo: s.title ?? null, usd: fin(s.estUsdPerDay) ? s.estUsdPerDay : null });
  }
  const reali = new Map();
  for (const r of (Array.isArray(realePerMercato) ? realePerMercato : [])) {
    const id = norm(r && r.marketId);
    if (!id) continue;
    reali.set(id, (reali.get(id) || 0) + (fin(r.usd) ? r.usd : 0));
  }
  const righe = [];
  for (const id of new Set([...stime.keys(), ...reali.keys()])) {
    const s = stime.has(id) ? stime.get(id).usd : null;
    const r = reali.has(id) ? reali.get(id) : null;
    const sc = scarto({ stimaUsd: s, realeUsd: r });
    righe.push({
      marketId: id,
      titolo: stime.has(id) ? stime.get(id).titolo : null,
      stimaUsd: s, realeUsd: r,
      assolutoUsd: sc.assolutoUsd, percentuale: sc.percentuale, direzione: sc.direzione,
      stato: s == null ? 'incassato-senza-stima' : (r == null ? 'stimato-senza-consuntivo' : 'confrontabile'),
    });
  }
  return righe.sort((a, b) => Math.abs(b.assolutoUsd ?? 0) - Math.abs(a.assolutoUsd ?? 0));
}

/**
 * IL VERDETTO SULLA DERIVA. Puro: prende le giornate e restituisce se la stima sta sbagliando in modo
 * sistematico, con i numeri su cui lo dice. Vedi le costanti in cima per il perché delle soglie.
 *
 * Tre esiti, e la differenza fra i primi due è tutto il punto:
 *   'dati-insufficienti' — non ci sono abbastanza giornate confrontabili. NON è «va tutto bene».
 *   'coerente'           — misurato, e lo scarto sta sotto soglia o non è sistematico.
 *   'divergente'         — misurato, oltre soglia e nello stesso verso: da rivedere.
 */
function divergenza(giorni = [], { sogliaPct = SOGLIA_SCARTO_PCT, minimo = OSSERVAZIONI_MINIME, concordanzaMinima = CONCORDANZA_MINIMA } = {}) {
  const conf = (Array.isArray(giorni) ? giorni : [])
    .filter((g) => g && g.realeDisponibile === true && fin(g.percentuale) && fin(g.stimaUsd) && fin(g.realeUsd));
  const base = {
    osservazioni: conf.length, sogliaPct, minimo,
    medianaPct: null, mediaPct: null, concordanza: null, direzione: null,
    giorniUsati: conf.map((g) => g.giorno),
  };
  if (conf.length < minimo) {
    return {
      ...base, stato: 'dati-insufficienti', avviso: false,
      messaggio: `servono ${minimo} giornate confrontabili per un primo giudizio: ce ne sono ${conf.length}`,
    };
  }
  const perc = conf.map((g) => g.percentuale).sort((a, b) => a - b);
  const mediana = perc.length % 2
    ? perc[(perc.length - 1) / 2]
    : +(((perc[perc.length / 2 - 1] + perc[perc.length / 2]) / 2).toFixed(2));
  const media = +(perc.reduce((s, x) => s + x, 0) / perc.length).toFixed(2);
  const sopra = perc.filter((x) => x > 0).length;
  const sotto = perc.filter((x) => x < 0).length;
  const concordanza = +(Math.max(sopra, sotto) / perc.length).toFixed(3);
  const direzione = mediana > 0 ? 'sovrastima' : (mediana < 0 ? 'sottostima' : 'esatta');
  const oltre = Math.abs(mediana) >= sogliaPct;
  const sistematico = concordanza >= concordanzaMinima;
  const avviso = oltre && sistematico;
  return {
    ...base, medianaPct: mediana, mediaPct: media, concordanza, direzione,
    stato: avviso ? 'divergente' : 'coerente',
    avviso,
    messaggio: avviso
      ? `la stima ${direzione} il consuntivo del venue di ${Math.abs(mediana).toFixed(1)}% (mediana su ${conf.length} giornate, ${Math.round(concordanza * 100)}% nello stesso verso, soglia ${sogliaPct}%) — da rivedere, nessuna correzione automatica applicata`
      : (oltre
        ? `scarto mediano ${mediana.toFixed(1)}% ma non sistematico (solo ${Math.round(concordanza * 100)}% delle giornate nello stesso verso): imprecisione, non taratura sbagliata`
        : `scarto mediano ${mediana.toFixed(1)}% su ${conf.length} giornate, sotto la soglia del ${sogliaPct}%`),
  };
}

function leggiGrezzo(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(d && d.giorni) ? d.giorni : [];
  } catch { return []; }
}

function scriviAtomico(file, giorni) {
  const ordinati = giorni.slice().sort((a, b) => String(b.giorno).localeCompare(String(a.giorno))).slice(0, GIORNI_TENUTI);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // L'AVVISO VIAGGIA COL FILE, non solo con la rotta: chi apre `data/confronto-reward.json` — un
    // operatore, un altro processo, questa stessa sessione fra un mese — deve trovare il verdetto
    // accanto ai numeri che lo producono, senza doverlo ricalcolare e senza poterlo dimenticare.
    fs.writeFileSync(tmp, JSON.stringify({
      aggiornatoAl: new Date().toISOString(),
      divergenza: divergenza(ordinati),
      giorni: ordinati,
    }, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, count: ordinati.length, reason: null };
  } catch (e) { return { ok: false, count: 0, reason: e.message }; }
}

/**
 * SCRIVE LA STIMA della giornata. Idempotente: se per quel giorno c'è già, non la sovrascrive —
 * la fotografia è quella delle 23:55, e un secondo giro nella stessa finestra non deve rifarla.
 */
function registraStima({ giorno, stimaUsd, perMercato = null }, deps = {}) {
  const file = deps.confrontoFile || CONFRONTO_FILE;
  const giorni = leggiGrezzo(file);
  const esistente = giorni.find((g) => g.giorno === giorno);
  if (esistente && esistente.stimaUsd != null) {
    return { ok: true, scritto: false, motivo: 'stima già registrata per questa giornata' };
  }
  const riga = esistente || { giorno };
  riga.stimaUsd = fin(stimaUsd) ? +stimaUsd.toFixed(6) : null;
  riga.stimaPerMercato = Array.isArray(perMercato) ? perMercato : null;
  riga.stimaAt = new Date((deps.now || Date.now)()).toISOString();
  if (!esistente) giorni.push(riga);
  const w = scriviAtomico(file, giorni);
  return { ok: w.ok, scritto: w.ok, motivo: w.reason };
}

/**
 * SCRIVE IL CONSUNTIVO accanto alla stima, e calcola lo scarto.
 * Se il venue non l'ha dato, incrementa il contatore dei tentativi; esaurito `TENTATIVI_MAX` la riga
 * resta marcata non disponibile e nessuno riprova.
 */
function registraReale({ giorno, disponibile, realeUsd = null, motivo = null, tentativo = 1, perMercato = null, attribuito = null, righeLette = null, fonte = null, pagamenti = null }, deps = {}) {
  const file = deps.confrontoFile || CONFRONTO_FILE;
  const giorni = leggiGrezzo(file);
  const esistente = giorni.find((g) => g.giorno === giorno);
  const riga = esistente || { giorno, stimaUsd: null, stimaPerMercato: null, stimaAt: null };

  if (riga.realeUsd != null) return { ok: true, scritto: false, motivo: 'consuntivo già registrato' };

  riga.tentativi = Math.max(riga.tentativi || 0, tentativo);
  riga.realeAt = new Date((deps.now || Date.now)()).toISOString();

  // Quanto il venue ha davvero attribuito a NOI, e su quante righe: un 200 pieno di zeri con
  // `maker_address` a zero non è un consuntivo (vedi lib/maker/reward-reale.js), e chi legge il file
  // deve poter distinguere «non attribuito» da «rete caduta» senza aprire i log.
  if (attribuito !== null) riga.realeAttribuito = attribuito === true;
  if (fin(righeLette)) riga.realeRigheLette = righeLette;
  // DA DOVE viene la cifra, e con quali bonifici. Un consuntivo senza provenienza non è verificabile:
  // con il `transactionHash` accanto, chiunque può controllarlo on-chain senza fidarsi di questo file.
  if (fonte) riga.realeFonte = fonte;
  if (Array.isArray(pagamenti) && pagamenti.length) riga.realePagamenti = pagamenti;

  if (disponibile && fin(realeUsd)) {
    riga.realeUsd = +realeUsd.toFixed(6);
    riga.realeDisponibile = true;
    riga.realeMotivo = null;
    riga.realePerMercato = Array.isArray(perMercato) ? perMercato : null;
    Object.assign(riga, scarto({ stimaUsd: riga.stimaUsd, realeUsd: riga.realeUsd }));
    // La scomposizione: un totale che torna può nascondere due errori che si compensano.
    riga.perMercato = scartoPerMercato({ stimaPerMercato: riga.stimaPerMercato, realePerMercato: riga.realePerMercato });
  } else {
    // MAI zero. Vedi l'intestazione: «non l'ho ricevuto» e «ho guadagnato zero» sono due fatti diversi.
    riga.realeUsd = null;
    riga.realeDisponibile = false;
    riga.realeMotivo = motivo || 'consuntivo non disponibile';
    riga.esaurito = riga.tentativi >= TENTATIVI_MAX;
  }

  if (!esistente) giorni.push(riga);
  const w = scriviAtomico(file, giorni);
  return { ok: w.ok, scritto: w.ok, esaurito: riga.esaurito === true, motivo: w.reason };
}

/** Lo storico, il più recente per primo. */
function leggiConfronto(deps = {}) {
  const file = deps.confrontoFile || CONFRONTO_FILE;
  const giorni = leggiGrezzo(file);
  const conReale = giorni.filter((g) => g.realeDisponibile === true && fin(g.assolutoUsd));
  return {
    leggibile: true,
    giorni,
    count: giorni.length,
    // Lo scarto medio sulle sole giornate confrontabili: una media che includesse i giorni senza
    // consuntivo racconterebbe una precisione che non è stata misurata.
    scartoMedioPct: conReale.length
      ? +(conReale.reduce((s, g) => s + (g.percentuale || 0), 0) / conReale.length).toFixed(2)
      : null,
    giorniConfrontabili: conReale.length,
    // Il verdetto sulla deriva, ricalcolato in lettura: chi legge non si fida di un campo scritto da
    // un'altra versione del codice, e la funzione è pura, quindi ricalcolarlo non costa niente.
    divergenza: divergenza(giorni),
  };
}

module.exports = {
  giorniDaRecuperare, MAX_RECUPERO_GIORNI,
  compitiDovuti, scarto, scartoPerMercato, divergenza, registraStima, registraReale, leggiConfronto,
  CONFRONTO_FILE, ORA_STIMA, ORE_REALE, TENTATIVI_MAX, GIORNI_TENUTI,
  SOGLIA_SCARTO_PCT, OSSERVAZIONI_MINIME, CONCORDANZA_MINIMA,
};

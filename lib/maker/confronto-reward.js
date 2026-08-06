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
    fs.writeFileSync(tmp, JSON.stringify({ aggiornatoAl: new Date().toISOString(), giorni: ordinati }, null, 2));
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
function registraReale({ giorno, disponibile, realeUsd = null, motivo = null, tentativo = 1 }, deps = {}) {
  const file = deps.confrontoFile || CONFRONTO_FILE;
  const giorni = leggiGrezzo(file);
  const esistente = giorni.find((g) => g.giorno === giorno);
  const riga = esistente || { giorno, stimaUsd: null, stimaPerMercato: null, stimaAt: null };

  if (riga.realeUsd != null) return { ok: true, scritto: false, motivo: 'consuntivo già registrato' };

  riga.tentativi = Math.max(riga.tentativi || 0, tentativo);
  riga.realeAt = new Date((deps.now || Date.now)()).toISOString();

  if (disponibile && fin(realeUsd)) {
    riga.realeUsd = +realeUsd.toFixed(6);
    riga.realeDisponibile = true;
    riga.realeMotivo = null;
    Object.assign(riga, scarto({ stimaUsd: riga.stimaUsd, realeUsd: riga.realeUsd }));
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
  };
}

module.exports = {
  compitiDovuti, scarto, registraStima, registraReale, leggiConfronto,
  CONFRONTO_FILE, ORA_STIMA, ORE_REALE, TENTATIVI_MAX, GIORNI_TENUTI,
};

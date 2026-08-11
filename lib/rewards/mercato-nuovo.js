'use strict';
// lib/rewards/mercato-nuovo.js — QUANDO ABBIAMO VISTO UN MERCATO PER LA PRIMA VOLTA.
//
// ═══ A COSA SERVE ═══════════════════════════════════════════════════════════════════════════════════
// «Meno concorrenza» non e' misurabile direttamente — non sappiamo quanti maker guardano un mercato. Il
// suo proxy piu' onesto e' l'ETA': un mercato entrato nel programma reward da poche ore ha avuto meno
// tempo di essere scoperto da chiunque altro. A parita' di rate, il piu' giovane vale di piu'.
//
// ═══ PERCHE' NON `startDate` DI GAMMA ═══════════════════════════════════════════════════════════════
// Era la strada ovvia ed e' stata scartata su misura: Polymarket lo riscrive quasi ogni giorno, e in una
// diagnosi precedente produceva l'82% di falsi positivi. Un campo che il venue puo' cambiare quando vuole
// non e' una data di nascita, e' un campo modificabile.
//
// La fonte affidabile e' NOSTRA: `data/history/rewards-poly/`, gli snapshot che scriviamo dal 12 luglio
// 2026. «Prima volta che LO ABBIAMO VISTO» e' un fatto che nessuno puo' riscrivere a posteriori. E' lo
// stesso principio di `lib/carry-first-seen.js` — di cui questo modulo riusa la FORMA (camminata sui
// file giornalieri, cache in module scope con TTL) ma non il codice: quello legge `history/basis` e
// tiene il massimo `daysToExpiry`, un'altra domanda su un'altra directory.
//
// ═══ ⚠ IL SEGNALE OGGI E' CONFUSO ALLA RADICE, E PER QUESTO NASCE SPENTO ════════════════════════════
// Gli snapshot storici li ha scritti agent24 CON il taglio ai primi 120 per rate. Quindi, per tutto lo
// storico esistente, «assente dallo storico» non significa «nuovo»: significa «non e' mai stato nei primi
// 120». Misurato il 10 agosto 2026: 1.222 mercati distinti in 1.090 snapshot, e **200 dei 308 mercati del
// board di oggi risultano mai visti** — il 65%. Una priorita' che promuove due terzi del board non e' una
// priorita'.
//
// E le due cause NON si separano a posteriori: il taglio storico era una POSIZIONE in classifica, non una
// soglia di rate, quindi non lascia una firma. Verificato: dei 200 assenti, 200 su 200 hanno un rate sopra
// il minimo mai registrato ($5/g). Nessun criterio su questi dati distingue «nuovo» da «era 121esimo».
//
// LA DECISIONE DELL'OPERATORE (11 agosto 2026): `BONUS_ATTIVO = true` DA SUBITO, con il tradeoff
// accettato esplicitamente. Per circa sette giorni ~200 mercati su 308 prenderanno il bonus «nuovo»
// senza esserlo — sono quelli che stavano fuori dai primi 120 e che lo storico non ha mai registrato.
//
// PERCHE' NON E' GRAVE QUANTO SEMBRA, e va detto per intero:
//   · il bonus e' un MOLTIPLICATORE SUL RATE (1,25x), non un riordino separato: un mercato scarso
//     promosso per errore resta scarso, sale solo rispetto a chi ha un rate simile;
//   · non salta nessun cancello. Banda, orizzonte, minSize, profondita', tetto per mercato e tutte le
//     regole per-ordine restano davanti e non sanno nemmeno che questo modulo esiste;
//   · si AUTO-PULISCE: ogni giorno che passa con lo storico scritto senza taglio, i mercati «mai visti»
//     per posizione in classifica vengono registrati e smettono di sembrare nuovi. Dopo
//     `GIORNI_MINIMI_SENZA_TAGLIO` giorni il segnale e' quello vero senza che nessuno tocchi niente.
// Il costo del periodo transitorio e' quindi un ordinamento piu' rumoroso, non un rischio nuovo.
//
// `attendibile` resta pubblicato e resta `false` finche' i giorni non bastano: il bonus si applica, ma
// chi legge l'audit vede che in questa finestra il segnale non e' ancora provato.
//
// ═══ COSA NON FA ════════════════════════════════════════════════════════════════════════════════════
// Non ordina, non filtra, non esclude. Restituisce un'eta' in giorni e un flag; chi legge decide. Un
// mercato di cui non si sa l'eta' resta `null` e non diventa «vecchio» ne' «nuovo» per difetto.

const fs = require('fs');
const path = require('path');

const HIST_DIR = path.join(process.cwd(), 'data', 'history', 'rewards-poly');
const TTL_MS = 30 * 60_000;

/** Il giorno in cui il taglio per numero e' stato rimosso da agent24 E il processo e' stato riavviato.
 *  Prima di questa data lo storico contiene solo i primi 120 per rate, quindi «assente» non e'
 *  informativo. La data e' quella del RIAVVIO, non quella del commit: finche' il processo vecchio gira,
 *  continua a scrivere snapshot troncati anche se il codice su disco e' gia' cambiato. */
const DAL_GIORNO_SENZA_TAGLIO = '2026-08-11';

/** Quanti giorni di storico NON troncato servono prima che il bonus possa accendersi onestamente. */
const GIORNI_MINIMI_SENZA_TAGLIO = 7;

/**
 * L'INTERRUTTORE. ACCESO dall'11 agosto 2026 su decisione esplicita dell'operatore, col tradeoff dei
 * sette giorni accettato — vedi il blocco qui sopra. Non e' una env: due interruttori per una decisione
 * sola vogliono dire che spegnerne uno non la spegne.
 */
const BONUS_ATTIVO = true;

/** Quanto vale il bonus quando sara' acceso: un moltiplicatore sul rate, non un riordino separato. */
const BONUS_MAX = 1.25;

/** Sotto questa eta' un mercato conta come «nuovo» e prende il bonus pieno; sopra, niente. */
const GIORNI_NUOVO = 2;

// La cache e' PER DIRECTORY. Con una cache sola, un chiamante che passa un `dir` diverso — un test, una
// sonda — riceverebbe la mappa dell'altra directory: il difetto lo ha trovato il test che verifica il
// caso «storico assente», che tornava con le eta' della directory vera. Chiave = dir.
const cache = new Map();

const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * marketId → istante (ms) del PRIMO snapshot in cui l'abbiamo visto.
 * Non solleva mai: storico assente o illeggibile ⇒ mappa vuota, che a valle vale «eta' ignota».
 */
function mappaPrimaVisto({ dir = HIST_DIR, now = Date.now() } = {}) {
  const c0 = cache.get(dir);
  if (c0 && c0.mappa && now - c0.at < TTL_MS) return c0;

  const mappa = Object.create(null);
  let giorniSenzaTaglio = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    const vuota = { at: now, mappa, giorniSenzaTaglio: 0 };
    cache.set(dir, vuota);          // si mette in cache anche la risposta vuota: non si ritenta a ogni giro
    return vuota;
  }

  for (const f of files) {
    const giorno = f.slice(0, 10);
    if (giorno >= DAL_GIORNO_SENZA_TAGLIO) giorniSenzaTaglio += 1;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const snap of (Array.isArray(doc) ? doc : [])) {
      if (!snap || typeof snap !== 'object') continue;
      const t = Number(snap.t) || Date.parse(snap.iso) || Date.parse(giorno);
      if (!Number.isFinite(t)) continue;
      for (const row of (snap.rows || [])) {
        const id = normId(row && row.id);
        if (!id) continue;
        // Il PRIMO, non l'ultimo: si tiene il minimo.
        if (!(id in mappa) || t < mappa[id]) mappa[id] = t;
      }
    }
  }

  const c = { at: now, mappa, giorniSenzaTaglio };
  cache.set(dir, c);
  return c;
}

/**
 * L'eta' di un mercato, in giorni, dalla prima volta che lo abbiamo visto.
 *
 * @returns {{giorni:number|null, nuovo:boolean|null, primaVistoMs:number|null, attendibile:boolean,
 *            motivo:string|null}}
 *   `attendibile:false` finche' lo storico e' quello troncato: l'eta' si calcola comunque e si pubblica,
 *   ma chi la usa per decidere deve sapere che «mai visto» puo' voler dire «mai stato nei primi 120».
 */
function etaMercato(marketId, { dir = HIST_DIR, now = Date.now() } = {}) {
  const id = normId(marketId);
  const c = mappaPrimaVisto({ dir, now });
  const attendibile = c.giorniSenzaTaglio >= GIORNI_MINIMI_SENZA_TAGLIO;
  const motivo = attendibile ? null
    : `storico non ancora affidabile: ${c.giorniSenzaTaglio}/${GIORNI_MINIMI_SENZA_TAGLIO} giorni scritti senza il taglio ai primi 120`;
  if (!id) return { giorni: null, nuovo: null, primaVistoMs: null, attendibile, motivo: motivo || 'marketId assente' };
  const primo = c.mappa[id];
  if (!Number.isFinite(primo)) {
    // Mai visto: con lo storico troncato NON e' una prova di novita'. Si dichiara ignoto invece di
    // dedurre — e' la stessa disciplina con cui una scadenza illeggibile non diventa «lontana».
    // Mai visto ⇒ NUOVO. Con lo storico ancora troncato questo include i mercati che erano solo fuori
    // dai primi 120: e' il tradeoff accettato l'11 agosto, e `attendibile:false` lo dichiara a chi legge.
    return { giorni: null, nuovo: true, primaVistoMs: null, attendibile,
      motivo: attendibile ? 'assente da tutto lo storico: mercato nuovo'
        : `assente dallo storico, ma ${motivo} — puo' essere un mercato che stava fuori dai primi 120` };
  }
  const giorni = +((now - primo) / 86_400_000).toFixed(3);
  return { giorni, nuovo: giorni <= GIORNI_NUOVO, primaVistoMs: primo, attendibile, motivo };
}

/**
 * IL MOLTIPLICATORE DI PRIORITA'. Si applica DOPO l'ordinamento per rate e non al posto suo: il rate
 * resta il criterio, l'eta' e' un correttivo a parita' di rate.
 *
 * Con `BONUS_ATTIVO` a false restituisce SEMPRE 1 — cioe' non cambia nessuna classifica — e dichiara
 * perche'. E' il comportamento voluto finche' lo storico non e' affidabile.
 */
function bonusPriorita(marketId, opts = {}) {
  const e = etaMercato(marketId, opts);
  if (!BONUS_ATTIVO) {
    return { moltiplicatore: 1, applicato: false, eta: e,
      motivo: `bonus spento: ${e.motivo || 'in attesa di storico non troncato'}` };
  }
  // NON si richiede piu' `attendibile`: la decisione dell'operatore e' applicare il bonus da subito e
  // lasciare che il segnale si pulisca da solo. `attendibile` continua a viaggiare nell'esito.
  if (e.nuovo !== true) {
    return { moltiplicatore: 1, applicato: false, eta: e, motivo: e.motivo || 'mercato non nuovo' };
  }
  return { moltiplicatore: BONUS_MAX, applicato: true, eta: e,
    motivo: `mercato nuovo (${e.giorni == null ? 'mai visto' : e.giorni + 'g'}): priorita' ${BONUS_MAX}x a parita' di rate` };
}

module.exports = {
  mappaPrimaVisto, etaMercato, bonusPriorita,
  BONUS_ATTIVO, BONUS_MAX, GIORNI_NUOVO, GIORNI_MINIMI_SENZA_TAGLIO, DAL_GIORNO_SENZA_TAGLIO, HIST_DIR,
};

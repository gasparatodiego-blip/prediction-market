'use strict';
// lib/maker/cancellazione-di-emergenza.js — QUANDO IL DEAD-MAN SVUOTA IL LIBRO, SI DEVE VEDERE.
//
// ═══ IL PROBLEMA CHE RISOLVE ═════════════════════════════════════════════════════════════════════════
// Nella notte fra il 5 e il 6 agosto 2026, alle 00:16:03.029 UTC, agent37-maker-watchdog ha constatato
// che il battito del maker era fermo da 121s (soglia 120s) e ha cancellato NOVE ordini reali su cinque
// mercati — l'intero libro a riposo, $663 di capitale tornati fermi. È la cosa che quel guardiano deve
// poter fare, e non è in discussione.
//
// Quello che non ha fatto è dirlo. Le sue tre righe sono finite in un log di processo
// (~/.pm2/logs/agent37-maker-watchdog-out.log), il Telegram era «not configured», e la cancellazione non
// ha nemmeno lasciato un record nel registro maker — che è il posto dove si va a guardare. Il mattino
// dopo la scena era: libro vuoto, capitale liquido, nessuna posizione, e nessuna spiegazione visibile.
// Ricostruirla ha richiesto di incrociare quattro file di log.
//
// ═══ COSA FA QUESTO MODULO, E COSA NON FA ═══════════════════════════════════════════════════════════
// Deposita il referto dove la dashboard lo può leggere. Non cancella, non piazza, non decide: il libro
// è già vuoto quando questo file viene scritto. Non è un gate e non blocca niente — è un avviso, e un
// avviso che si traveste da blocco è il modo più rapido per far ignorare entrambi.
//
// Sorella di [[residui-sotto-soglia]] e di [[scadenze-senza-rinnovo]]: stessa forma, stessa superficie
// («Stato wallet e piazzamento» via /api/maker/wallet-status), stesso principio — la DECISIONE era
// registrata, il suo ESITO no, e l'esito è la parte che costa.
//
// ═══ I QUATTRO NUMERI CHE DEVE PORTARE ══════════════════════════════════════════════════════════════
// Perché «il watchdog è scattato» da solo non dice se alzarsi:
//   • quanti ordini sono stati cancellati, e su quanti mercati;
//   • quale soglia è stata superata (il dead-man in secondi), così si sa contro cosa si è misurato;
//   • da quanto era fermo il battito quando è scattata — la distanza dalla soglia dice se è stato un
//     pelo o un crollo (121s contro 120s è un pelo, ed è un'informazione diversa da 600s);
//   • quanto capitale è tornato libero, che è la cifra che decide se rimettere ordini stanotte o domani.
//
// ═══ LA FINESTRA DI VISIBILITÀ ══════════════════════════════════════════════════════════════════════
// DODICI ORE, non la mezz'ora dei residui. La differenza non è stilistica: un residuo sotto soglia è
// una voce che si somma ad altre durante una giornata di lavoro, questo è un evento che svuota il libro
// e che — come il 6 agosto — capita alle quattro del mattino. Un avviso già scaduto quando l'operatore
// apre il pannello non è un avviso. Il filtro è nel LETTORE oltre che nello scrittore, così se il
// processo che scrive si ferma le voci invecchiano lo stesso invece di restare appese lì per sempre.

const fs = require('fs');
const path = require('path');
// La stessa risoluzione di `data/` usata dagli altri moduli maker: questo file lo carica agent37 come
// node semplice E la dashboard dentro il bundle di Next, e un `path.join(__dirname, '..', '..')` darebbe
// due cartelle diverse.
const { DATA_DIR } = require('../safety/store');

const CANCELLAZIONI_FILE = path.join(DATA_DIR, 'cancellazioni-di-emergenza.json');
const RETENTION_MS = 12 * 3_600_000;

// Si conta dall'istante in cui la cancellazione è avvenuta. Senza una data leggibile la voce non è
// tenibile: una riga che non sa quando è nata non deve poter restare eterna.
const vivo = (r, now) => {
  const base = Date.parse((r && r.at) || '');
  if (!Number.isFinite(base)) return false;
  return now - base <= RETENTION_MS;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Costruisce il referto da ciò che il watchdog ha in mano al momento dello scatto. PURA: nessun I/O, così
 * la forma è verificabile da sola.
 *
 * Un campo che non si sa NON viene inventato: resta `null`. In particolare `capitaleUsd` è `null`, mai 0,
 * quando anche un solo ordine non era leggibile — «zero dollari tornati liberi» accanto a nove ordini
 * cancellati manderebbe l'operatore a dormire tranquillo su una cifra falsa.
 *
 * @param {object} args
 *   at             epoch ms dello scatto
 *   stalenessSec   da quanto era fermo il battito quando è scattata
 *   thresholdSec   la soglia dead-man superata
 *   heartbeatTs    epoch ms dell'ultimo battito visto (null se non leggibile)
 *   results        l'array restituito da cancelAllOrders()
 */
function costruisciCancellazione({
  at, stalenessSec, thresholdSec, heartbeatTs = null, results = [],
  ambito = 'tutto', motoriMorti = [], motoriVivi = [],
} = {}) {
  const venues = Array.isArray(results) ? results : [];
  const ordini = venues.reduce((a, r) => a + (Number.isFinite(r && r.cancelled) ? r.cancelled : 0), 0);
  const mercati = venues.reduce((a, r) => a + ((r && Array.isArray(r.markets)) ? r.markets.length : 0), 0);
  // Un venue il cui controvalore non è leggibile rende null il totale, non lo si salta.
  let capitaleUsd = 0;
  for (const r of venues) {
    if (!r || r.notionalUsd == null) { capitaleUsd = null; break; }
    capitaleUsd += Number(r.notionalUsd) || 0;
  }
  return {
    type: 'cancellazione-di-emergenza',
    at: new Date(at).toISOString(),
    // La chiave di deduplica. Un episodio di battito fermo produce UNO scatto (agent37 tiene la sua
    // latch `triggeredForEpisode`), quindi l'istante identifica l'evento senza bisogno di altro.
    id: `deadman-${at}`,
    stalenessSec: num(stalenessSec),
    thresholdSec: num(thresholdSec),
    oltreSogliaSec: (num(stalenessSec) != null && num(thresholdSec) != null) ? num(stalenessSec) - num(thresholdSec) : null,
    heartbeatAt: Number.isFinite(heartbeatTs) ? new Date(heartbeatTs).toISOString() : null,
    ordiniCancellati: ordini,
    mercatiToccati: mercati,
    capitaleUsd: capitaleUsd == null ? null : +capitaleUsd.toFixed(2),
    // ── QUANTO LIBRO È SPARITO, E QUANTO NO ─────────────────────────────────────────────────────
    // 'tutto'  = nessun motore rispondeva più: il libro è vuoto.
    // 'corsie' = un motore è morto e l'altro sta ancora lavorando: è sparita SOLO la sua parte, e il
    //            resto degli ordini è dove l'hai lasciato. Sono due mattine molto diverse, e prima
    //            del 6 agosto 2026 il guardiano sapeva produrre solo la prima.
    ambito,
    motoriMorti: (Array.isArray(motoriMorti) ? motoriMorti : []).map((m) => ({
      id: (m && m.id) || null, processo: (m && m.processo) || null,
      etichetta: (m && m.etichetta) || null, stalenessSec: num(m && m.stalenessSec),
    })),
    motoriVivi: (Array.isArray(motoriVivi) ? motoriVivi : []).map((m) => ({
      id: (m && m.id) || null, processo: (m && m.processo) || null,
      etichetta: (m && m.etichetta) || null, stalenessSec: num(m && m.stalenessSec),
    })),
    // Gli ordini LASCIATI dove sono da una cancellazione mirata, con il proprietario di ciascuno. Un
    // referto che dice solo cosa ha tolto non permette di sapere cosa è rimasto vivo sul book.
    ordiniLasciati: venues.reduce((a, r) => a + ((r && Array.isArray(r.skipped)) ? r.skipped.length : 0), 0),
    // `true` quando nessuna credenziale era presente: la cancellazione è stata SIMULATA e il libro non è
    // stato toccato. Va detto, altrimenti si cerca un libro vuoto che è ancora pieno.
    simulata: venues.length > 0 && venues.every((r) => r && r.simulated === true),
    // Un venue che ha risposto male: gli ordini potrebbero essere ancora lì. Non è la stessa cosa di
    // «cancellati», e chi legge deve poterlo distinguere.
    erroreVenue: venues.map((r) => (r && r.ok === false ? `${r.venue}: ${r.error}` : null)).filter(Boolean).join(' · ') || null,
    venues: venues.map((r) => ({
      venue: (r && r.venue) || null,
      corsia: (r && r.corsia) || null,
      ok: !(r && r.ok === false),
      cancelled: num(r && r.cancelled),
      venueOpenBefore: num(r && r.venueOpenBefore),
      notionalUsd: (r && r.notionalUsd != null) ? num(r.notionalUsd) : null,
      simulated: !!(r && r.simulated),
      markets: ((r && r.markets) || []).map((m) => ({
        market: (m && m.market) || null,
        cancelled: num(m && m.cancelled),
        notionalUsd: (m && m.notionalUsd != null) ? num(m.notionalUsd) : null,
        ok: !(m && m.ok === false),
      })),
    })),
  };
}

/**
 * Registra una cancellazione di emergenza, tenendo quelle ancora dentro la finestra di visibilità.
 *
 * FONDE, non sovrascrive: la deduplica per `id` regge il caso di un agent37 riavviato fra lo scatto e la
 * lettura del pannello. Stesso pattern di residui-sotto-soglia e scadenze-senza-rinnovo.
 *
 * @returns {{ok:boolean, written:boolean, count:number, reason:(string|null)}}
 */
function registraCancellazioneDiEmergenza(nuova, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.cancellazioniFile || CANCELLAZIONI_FILE;
  const t = now();
  const precedenti = leggiGrezzo(file).cancellazioni.filter((r) => vivo(r, t));
  const perId = new Map(precedenti.map((r) => [r.id, r]));
  for (const r of (Array.isArray(nuova) ? nuova : [nuova])) {
    if (!r || !r.id || perId.has(r.id)) continue;
    perId.set(r.id, r);
  }
  const cancellazioni = [...perId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: t, atIso: new Date(t).toISOString(), cancellazioni }, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, written: true, count: cancellazioni.length, reason: null };
  } catch (e) {
    return { ok: false, written: false, count: cancellazioni.length, reason: e.message };
  }
}

function leggiGrezzo(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { at: Number(raw && raw.at), cancellazioni: Array.isArray(raw && raw.cancellazioni) ? raw.cancellazioni : [] };
  } catch {
    return { at: NaN, cancellazioni: [] };
  }
}

/**
 * Le cancellazioni di emergenza da mostrare adesso.
 *
 * Un file assente NON è un errore: significa che il dead-man non è mai scattato nelle ultime dodici ore,
 * che è lo stato normale e desiderato.
 */
function readCancellazioniDiEmergenza(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.cancellazioniFile || CANCELLAZIONI_FILE;
  const t = now();
  const grezzo = leggiGrezzo(file);
  const cancellazioni = grezzo.cancellazioni.filter((r) => r && r.id && vivo(r, t));
  const conCapitale = cancellazioni.filter((r) => Number.isFinite(r.capitaleUsd));
  return {
    at: Number.isFinite(grezzo.at) ? grezzo.at : null,
    cancellazioni,
    count: cancellazioni.length,
    ordiniCancellati: cancellazioni.reduce((s, r) => s + (Number.isFinite(r.ordiniCancellati) ? r.ordiniCancellati : 0), 0),
    capitaleUsd: conCapitale.length ? +conCapitale.reduce((s, r) => s + r.capitaleUsd, 0).toFixed(2) : null,
  };
}

module.exports = {
  costruisciCancellazione, registraCancellazioneDiEmergenza, readCancellazioniDiEmergenza,
  CANCELLAZIONI_FILE, RETENTION_MS,
};

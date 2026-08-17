#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent45-osservatore — L'OSSERVATORE MUTO.
//
// ═══ COSA FA, E COSA NON FARÀ MAI ═══════════════════════════════════════════════════════════════
// Campiona ogni 60 secondi e scrive due file. **Non decide, non agisce, non avvisa.** Non piazza, non
// cancella, non riprezza, non tocca AVVIA/FERMA/KILL, non scrive in nessun file di stato di nessun
// altro agente. La sua unica scrittura è `data/osservatore/`.
//
// ⚠ LA PROPRIETÀ È STRUTTURALE, NON UNA PROMESSA. L'elenco dei `require` qui sotto è corto apposta e
// contiene solo fonti provatamente di sola lettura:
//   · `saldo-cache`            — una `eth_call balanceOf` su un provider SENZA signer (lo dichiara la
//                                sua intestazione: «nessuna chiave viene caricata»);
//   · `venue-positions-snapshot` — legge un file locale scritto da agent40;
//   · `guardian-perdite`       — modulo PURO (aritmetica del PnL, nessun effetto);
//   · `fs`/`path`              — lettura dei file di stato e scrittura del proprio giornale.
// NON importa l'adapter del venue, né `manual-order`, né `cancel-all`, né il signer. Un test
// (`lib/osservatore/campionamento.test.js`) cammina l'albero dei `require` e fallisce se qualcuno ce
// li trascina dentro. È la stessa difesa di agent42 e agent44.
//
// ═══ PERCHÉ IL CONTEGGIO DEGLI ORDINI È «RICOSTRUITO» E NON «DIRETTO» ═══════════════════════════
// Leggere gli ordini vivi dal venue richiede una chiamata AUTENTICATA, che nel repo passa dall'adapter
// — cioè dalla stessa superficie che sa piazzare. Importarla renderebbe questo processo capace di
// toccare capitale, e quella proprietà vale più della freschezza del campo. Si legge quindi il
// conteggio che agent40 ha già osservato (righe `manual-list` senza filtro di mercato), **dichiarando
// l'età della lettura**. È una ricostruzione, il campo lo dice, e il riepilogo dice cosa servirebbe
// per renderla diretta.
//
// ═══ NON DEVE POTER FAR CADERE IL BOT ═══════════════════════════════════════════════════════════
// Ogni lettura è avvolta in un `try`: una fonte che non risponde diventa `null` con il motivo, e il
// giro prosegue. Un errore inatteso diventa una riga `errore` nel giornale e basta — non si propaga,
// non termina il processo, non blocca il campione successivo.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── IL CARICATORE DI `.env` — stesso blocco di agent40/41/43, e per la stessa ragione (§5.3):
// un riavvio del DEMONE pm2 risorge da un dump pulito, e senza questo il saldo non si leggerebbe.
// NON SOVRASCRIVE MAI ciò che pm2 già passa.
for (const envFile of ['.env.local', '.env']) {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', envFile), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file assente → si prosegue con l'ambiente che c'è */ }
}

const { leggiSaldoUsd } = require('../lib/maker/saldo-cache');
const { readVenuePositions } = require('../lib/safety/venue-positions-snapshot');
const { calcolaPnl, leggiBaseline, valutaCapitale } = require('../lib/maker/guardian-perdite');
const OSS = require('../lib/osservatore/campionamento');

// ── I PERCORSI PRIMA DI TUTTO — 17 agosto 2026 ─────────────────────────────────────────────────────
// Se `data/`, la directory di servizio o un file di servizio gia' esistente non sono utilizzabili da
// QUESTO processo, ci si ferma qui e lo si dice. Non e' prudenza generica: il 17 agosto nove file di
// `/tmp` erano di un altro utente, gli scrittori prendevano EACCES e **i lettori continuavano a leggere
// la copia vecchia, che da quel momento non invecchiava piu'**. Un processo «online» che decide su una
// fotografia ferma e' peggio di un processo caduto. Dettagli in `lib/safety/percorsi-critici.js`.
require('../lib/safety/percorsi-critici').verificaOMuori('agent45-osservatore');

const RADICE = path.join(__dirname, '..');
const DATA = path.join(RADICE, 'data');
const DIR = path.join(DATA, 'osservatore');
// ⚠ LA HOME DI pm2 SI LEGGE, NON SI CABLA (17 agosto 2026, migrazione root → bot). Era
// `/root/.pm2/logs/...`: dopo il cambio di utente il file non e' nemmeno apribile, e `codaNuova`
// restituisce stringa vuota — cioe' «il guardiano non ha detto niente», che e' indistinguibile da «il
// guardiano sta bene». `PM2_HOME` e' la variabile che pm2 stesso esporta ai figli; la home dell'utente
// e' il ripiego, ed e' quella che pm2 usa quando `PM2_HOME` non e' impostata.
const CASA_PM2 = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const LOG_GUARDIANO = path.join(CASA_PM2, 'logs', 'agent43-guardian-out.log');
const GIORNALE_MAKER = path.join(DATA, 'polymarket-maker-audit.jsonl');

const log = (...a) => console.log(new Date().toISOString(), '[agent45-osservatore]', ...a);

/** Legge un JSON senza mai sollevare. `null` = non leggibile, e non è mai un oggetto vuoto. */
function json(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

const oggi = () => new Date().toISOString().slice(0, 10);
const fileCampioni = (g) => path.join(DIR, `campioni-${g}.jsonl`);
const fileGiornale = (g) => path.join(DIR, `giornale-${g}.md`);

/**
 * Append che non può far cadere il processo. Se il disco non risponde, si perde una riga, non il bot.
 *
 * ⚠ SI RICREA LA DIRECTORY DA SOLO. `main()` la crea all'avvio, ma può sparire dopo — una pulizia
 * manuale, un volume rimontato — e allora l'osservatore smetterebbe di scrivere per sempre restando
 * vivo, cioè il modo peggiore di rompersi: un processo che sembra funzionare e non registra niente.
 * Un solo tentativo di recupero, e se non basta si dichiara e si prosegue.
 */
function scrivi(file, testo) {
  try { fs.appendFileSync(file, testo); return true; } catch (e) {
    if (e && e.code === 'ENOENT') {
      try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(file, testo); return true; }
      catch (e2) { log('scrittura fallita anche dopo aver ricreato la directory:', e2.message); return false; }
    }
    log('scrittura fallita:', e.message);
    return false;
  }
}

// ══ LETTURA INCREMENTALE DELLE CODE, per gli eventi ═══════════════════════════════════════════════
// Si tiene l'offset in byte e si legge solo la parte nuova: il giornale maker supera i 170 MB e
// rileggerlo tutto a ogni giro sarebbe l'unico modo in cui questo processo potrebbe pesare davvero.
// Rilevata una rotazione (il file si è accorciato), si riparte dalla fine — non dall'inizio: recuperare
// 170 MB di storia in un colpo è esattamente ciò che si vuole evitare.
const offset = new Map();
function codaNuova(file) {
  try {
    const st = fs.statSync(file);
    const prec = offset.get(file);
    if (prec === undefined) { offset.set(file, st.size); return ''; }   // primo giro: si parte da adesso
    if (st.size < prec) { offset.set(file, st.size); return ''; }        // ruotato
    if (st.size === prec) return '';
    const n = st.size - prec;
    // Tetto di sicurezza: se per qualche motivo si è accumulato troppo, si legge l'ultima parte e si
    // dichiara. Meglio un pezzo di coda che un picco di memoria in un processo che deve pesare zero.
    const TETTO = 8 * 1024 * 1024;
    const da = n > TETTO ? st.size - TETTO : prec;
    const buf = Buffer.alloc(st.size - da);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, da); } finally { fs.closeSync(fd); }
    offset.set(file, st.size);
    return buf.toString('utf8');
  } catch { return ''; }
}

// ── GLI EVENTI DEL GUARDIANO, dal suo log pm2 ───────────────────────────────────────────────────
const RE_PRE = /^(\S+Z) \[agent43-guardian\] PRE-ALLARME \((\d+)\/(\d+)\) — .*?PnL ([+-]?[\d.]+) USD/;
const RE_SCA = /^(\S+Z) \[agent43-guardian\] SCATTO: superate: .*?\(([+-][\d.]+)% .*?\(([+-][\d.]+)USD/;
function eventiGuardiano() {
  const out = [];
  for (const l of codaNuova(LOG_GUARDIANO).split('\n')) {
    let m = RE_PRE.exec(l);
    if (m) { out.push({ tipo: 'pre-allarme', at: Date.parse(m[1]), conferme: Number(m[2]), pnlUsd: Number(m[4]) }); continue; }
    m = RE_SCA.exec(l);
    if (m) out.push({ tipo: 'scatto', at: Date.parse(m[1]), pnlPct: Number(m[2]), pnlUsd: Number(m[3]) });
  }
  return out;
}

// ── (a) IL CONTEGGIO DEGLI ORDINI, ricostruito dalle osservazioni di agent40 ─────────────────────
// Si cerca l'ULTIMA riga di elenco NON filtrata per mercato nella coda recente del giornale. Si
// dichiara l'età: una ricostruzione vecchia di dieci minuti non è la stessa cosa di una di trenta
// secondi, e chi legge deve poterlo vedere.
let ultimoConteggio = null;
function conteggioOrdini(testoCoda) {
  for (const l of (testoCoda || '').split('\n')) {
    if (l.indexOf('"manual-list"') < 0) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.op !== 'manual-list') continue;
    const mid = j.requested ? j.requested.marketId : undefined;
    const c = j.response ? Number(j.response.count) : NaN;
    if ((mid === null || mid === undefined) && Number.isFinite(c)) ultimoConteggio = { totale: c, at: j.ts };
  }
  if (!ultimoConteggio) return null;
  return { totale: ultimoConteggio.totale, etaMs: Date.now() - ultimoConteggio.at };
}

// ── (c) IL NOZIONALE A BOOK, ricostruito per mercato ─────────────────────────────────────────────
const espoPerMercato = new Map();
function nozionaleABook(testoCoda) {
  for (const l of (testoCoda || '').split('\n')) {
    if (l.indexOf('esposizioneOrdiniUsd') < 0) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const o = j.observed || {};
    if (!Number.isFinite(o.esposizioneOrdiniUsd)) continue;
    const m = String(j.marketRef || '').replace(/^cid_/, '');
    if (m) espoPerMercato.set(m, { usd: o.esposizioneOrdiniUsd, at: j.ts });
  }
  const ora = Date.now();
  let tot = 0; let visti = 0;
  for (const [m, v] of [...espoPerMercato]) {
    if (ora - v.at > 15 * 60_000) { espoPerMercato.delete(m); continue; }   // stantio: si scarta
    visti++; tot += v.usd;
  }
  return visti ? { usd: +tot.toFixed(4), mercati: visti } : null;
}

// ── (h) I REWARD DI GIORNATA ────────────────────────────────────────────────────────────────────
// Il venue paga un bonifico AGGREGATO e il consuntivo del giorno arriva la notte dopo (§4.12), quindi
// «maturati dall'inizio giornata» non è leggibile in tempo reale da nessuna fonte. Si riporta il
// consuntivo REALE del giorno se già registrato, e altrimenti `null` col motivo: la stima esiste ma
// è un'altra grandezza, e spacciarla per l'incassato sarebbe un numero inventato.
function rewardOggi() {
  const j = json(path.join(DATA, 'confronto-reward.json'));
  if (!j || !Array.isArray(j.giorni)) return { usd: null, motivo: 'registro reward non leggibile' };
  const g = j.giorni.find((x) => x && x.giorno === oggi());
  if (!g) return { usd: null, motivo: 'il consuntivo di oggi non è ancora stato pagato dal venue' };
  const r = Number(g.realeUsd ?? g.reale);
  if (!Number.isFinite(r)) return { usd: null, motivo: 'consuntivo di oggi presente ma senza valore reale' };
  return { usd: r, fonte: 'diretta' };
}

// ══ IL GIRO ══════════════════════════════════════════════════════════════════════════════════════
let precedenteAt = null;
let precedentePos = null;
let scoperteDa = new Map();
let campioniOra = [];
let oraCorrente = null;
let giornoCorrente = null;

async function giro() {
  const ora = Date.now();
  const eventi = [];

  // Ogni lettura è isolata: una fonte che tace non ferma le altre.
  let saldo = null;
  try { saldo = await leggiSaldoUsd(); } catch (e) { eventi.push({ tipo: 'errore', at: ora, messaggio: `saldo: ${e.message}` }); }
  let posizioni = null;
  try { posizioni = readVenuePositions(); } catch (e) { eventi.push({ tipo: 'errore', at: ora, messaggio: `posizioni: ${e.message}` }); }

  const statoBotRaw = json(path.join(DATA, 'maker-bot-enabled.json'));
  const killRaw = json(path.join(DATA, 'safety-kill-switch.json'));
  const latchRaw = json(path.join(DATA, 'guardian-state.json'));
  const baseRaw = json(path.join(DATA, 'guardian-baseline.json'));
  const baseline = baseRaw ? leggiBaseline(baseRaw) : null;

  // Il PnL con le funzioni VERE del guardiano: è l'unico modo perché il giornale mostri il numero su
  // cui il guardiano decide, e non una seconda aritmetica che gli somiglia.
  let pnlGuardiano = null;
  try {
    const cap = valutaCapitale({
      saldoUsd: saldo && saldo.affidabile ? saldo.usd : null,
      posizioni: posizioni && posizioni.readable ? posizioni.positions : null,
      posizioniLeggibili: !!(posizioni && posizioni.readable),
    });
    if (cap.leggibile && baseline && baseline.valido) {
      pnlGuardiano = calcolaPnl({ baselineUsd: baseline.baselineUsd, totaleUsd: cap.totaleUsd });
    }
  } catch (e) { eventi.push({ tipo: 'errore', at: ora, messaggio: `pnl: ${e.message}` }); }

  // Una sola lettura della coda del giornale maker, riusata da entrambi i ricostruttori: leggerla due
  // volte sarebbe la chiamata ridondante che il vincolo «non deve pesare» vieta.
  const coda = codaNuova(GIORNALE_MAKER);
  const ordini = conteggioOrdini(coda);
  const nozionale = nozionaleABook(coda);

  const campione = OSS.costruisciCampione({
    ora, precedenteAt, saldo, posizioni, baseline,
    ordini, nozionaleABook: nozionale, reward: rewardOggi(),
    statoBot: statoBotRaw, kill: killRaw && killRaw.global ? killRaw.global : null,
    latch: latchRaw, pnlGuardiano,
  });

  if (campione.saltati > 0) eventi.push({ tipo: 'salto', at: ora, saltati: campione.saltati, ritardoMs: campione.ritardoMs });

  // Le transizioni di copertura, dallo snapshot: è la grandezza che oggi manca del tutto.
  const posOra = { perMercato: campione.posizioniPerMercato };
  const tr = OSS.transizioniCopertura({ precedente: precedentePos, corrente: posOra, scoperteDa, ora });
  scoperteDa = tr.scoperteDa;
  eventi.push(...tr.eventi);
  precedentePos = posOra;

  // Gli eventi delle altre fonti. Il giornale maker è già stato letto sopra: si riusa la stessa coda.
  try { eventi.push(...eventiGuardiano()); } catch (e) { eventi.push({ tipo: 'errore', at: ora, messaggio: `log guardiano: ${e.message}` }); }
  // La coda del giornale maker è già stata letta una volta sola, sopra: si analizza quella in mano.
  try { eventi.push(...analizzaCoda(coda)); } catch (e) { eventi.push({ tipo: 'errore', at: ora, messaggio: `giornale maker: ${e.message}` }); }

  // ── ROTAZIONE GIORNALIERA ────────────────────────────────────────────────────────────────────
  const g = oggi();
  if (g !== giornoCorrente) {
    giornoCorrente = g;
    if (!fs.existsSync(fileGiornale(g))) {
      scrivi(fileGiornale(g), `# Giornale dell'osservatore — ${g}\n\n`
        + `Campione ogni ${OSS.CADENZA_MS / 1000}s. Sola lettura: questo processo non agisce mai.\n`
        + 'Le grandezze dichiarano la provenienza: `diretta` (letta dalla fonte),\n'
        + '`ricostruita` (dedotta da osservazioni di altri processi), `—` (non misurabile).\n');
    }
    pulisciVecchi();
  }

  scrivi(fileCampioni(g), `${JSON.stringify(campione)}\n`);
  if (eventi.length) scrivi(fileGiornale(g), `${eventi.map(OSS.rigaEvento).join('\n')}\n`);

  // ── SINTESI ORARIA ──────────────────────────────────────────────────────────────────────────
  const oraEtichetta = new Date(ora).toISOString().slice(0, 13).replace('T', ' ') + ':00 UTC';
  if (oraCorrente === null) oraCorrente = oraEtichetta;
  if (oraEtichetta !== oraCorrente) {
    scrivi(fileGiornale(g), OSS.bloccoSintesi({ campioni: campioniOra, oraEtichetta: oraCorrente }));
    campioniOra = [];
    oraCorrente = oraEtichetta;
  }
  campioniOra.push(campione);
  precedenteAt = ora;
}

/** Gli eventi dalla coda già letta: si separa da `eventiGiornale` per non rileggere il file. */
function analizzaCoda(testo) {
  const out = [];
  if (!testo) return out;
  let cancellati = 0; let sorgente = null; let ultimoAt = null;
  for (const l of testo.split('\n')) {
    if (l.length < 20) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const oc = String(j.outcome || '');
    if (j.op === 'sentinella-collasso') {
      const o = j.observed || {};
      out.push({ tipo: 'collasso', at: j.ts, ordini: o.ordiniARiposo, massimo: o.massimoRecenteOrdini, caloPct: o.caloPct });
    } else if (/^merge-onchain-(eseguito|fallito)$/.test(oc)) {
      out.push({ tipo: 'merge', at: j.ts, esito: oc.endsWith('eseguito') ? 'ok' : 'ko',
        conditionId: String(j.marketRef || '').replace(/^cid_/, '') });
    } else if (j.op === 'order-vanished' || (j.op === 'manual-cancel' && oc === 'ok')) {
      cancellati++; sorgente = j.source || sorgente; ultimoAt = j.ts || ultimoAt;
    }
  }
  if (cancellati > 0) out.push({ tipo: 'cancellazione', at: ultimoAt || Date.now(), quanti: cancellati, source: sorgente, byHand: false });
  return out;
}

/** Cancella SOLO i file che questo processo scrive, e solo oltre la scadenza. */
function pulisciVecchi() {
  try {
    const scaduti = OSS.fileDaCancellare({ nomi: fs.readdirSync(DIR), oggiIso: oggi() });
    for (const n of scaduti) { try { fs.unlinkSync(path.join(DIR, n)); log('rimosso file scaduto:', n); } catch { /* non blocca */ } }
  } catch { /* directory non leggibile: si riprova domani */ }
}

async function loop() {
  try { await giro(); } catch (e) {
    // ULTIMA RETE: qualunque cosa sia successa, si scrive e si continua. Un osservatore che muore
    // smette di osservare proprio quando è successo qualcosa di interessante.
    log('giro fallito:', e && e.message);
    try { scrivi(fileGiornale(oggi()), `${OSS.rigaEvento({ tipo: 'errore', at: Date.now(), messaggio: e && e.message })}\n`); } catch { /* nulla */ }
  }
  setTimeout(loop, OSS.CADENZA_MS);
}

function main() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { log('non riesco a creare', DIR, e.message); }
  log(`starting — un campione ogni ${OSS.CADENZA_MS / 1000}s in ${DIR}.`);
  log('  SOLA LETTURA: non piazza, non cancella, non tocca AVVIA/FERMA/KILL, non scrive stato altrui.');
  loop();
}

if (require.main === module) main();

module.exports = { giro, conteggioOrdini, nozionaleABook, rewardOggi, analizzaCoda, DIR };

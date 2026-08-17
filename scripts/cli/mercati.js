#!/usr/bin/env node
'use strict';
// scripts/cli/mercati.js — LA LISTA DEI MERCATI SU CUI IL BOT PUÒ QUOTARE, da terminale.
//
//   node scripts/cli/mercati.js                          elenca
//   node scripts/cli/mercati.js aggiungi <conditionId>   opt-in di un mercato
//   node scripts/cli/mercati.js rimuovi  <conditionId>   opt-out (l'ordine resta a libro fino al GTD)
//
// ═══ COSA SCRIVE, E PERCHÉ PROPRIO QUEL FILE ═════════════════════════════════════════════════════
// `data/maker-auto-reprice.json`, attraverso `lib/maker/auto-reprice-config.setAutoReprice` — la
// STESSA funzione che usava il pannello. Non si scrive il JSON a mano: quella funzione tiene il
// giornale (`maker-auto-reprice-audit.jsonl`), scrive in modo atomico e rifiuta di ACCENDERE su uno
// stato illeggibile. Riscriverlo qui sarebbe una seconda verità sullo stesso file.
//
// ⚠ QUESTA LISTA È IL CONFINE DI `MAKER_MODE=live-min`: l'adapter quota SOLO i mercati che stanno qui
// (più l'eventuale perno `MAKER_LIVE_MIN_MARKET`). Lista vuota ⇒ `live-min-market-unset`, cioè rifiuto.
// Aggiungere un mercato qui è quindi l'atto che AUTORIZZA il capitale su quel mercato, e per questo il
// comando stampa l'elenco prima e dopo invece di limitarsi a dire «fatto».
//
// ⚠ NON ACCENDE IL BOT. Servono, indipendentemente: `global.enabled` (lo mette questo comando alla
// prima aggiunta), l'interruttore AVVIA (`scripts/cli/avvia.js`), il KILL spento, e `MAKER_MODE` a
// mano nel `.env`. Un mercato in lista con il bot fermo non produce nessun ordine.

const fs = require('fs');
const C = require('./_comune');
const ARC = require('../../lib/maker/auto-reprice-config');

const [, , comando = 'elenca', arg] = process.argv;

function elenco() {
  const cfg = ARC.readAutoRepriceConfig();
  if (!cfg.readable) {
    C.errore(`la configurazione dei mercati non è leggibile (${cfg.error}) — nessun mercato è attivo, e questo è il fail-closed voluto: un automatismo che non si legge non agisce`);
    return null;
  }
  return cfg;
}

function mostra(cfg, intestazione = 'MERCATI') {
  C.titolo(intestazione);
  const abilitati = cfg.enabledMarketIds || [];
  const optIn = Object.keys(cfg.markets || {}).filter((k) => cfg.markets[k] && cfg.markets[k].enabled === true);
  console.log(`  interruttore generale : ${cfg.globalEnabled ? C.col.verde('ACCESO') : C.col.rosso('SPENTO')}`);
  if (!optIn.length) {
    console.log('  mercati               : ' + C.col.spento('nessuno'));
  } else {
    console.log(`  mercati con opt-in    : ${optIn.length}`);
    for (const id of optIn) {
      const r = cfg.markets[id] || {};
      const attivo = cfg.globalEnabled;
      console.log(`    ${attivo ? C.col.verde('●') : C.col.spento('○')} ${id}`
        + C.col.spento(`   ${r.by ? 'da ' + r.by : ''}${r.at ? ' · ' + new Date(r.at).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : ''}`));
    }
  }
  if (optIn.length && !cfg.globalEnabled) {
    console.log('\n  ' + C.col.giallo('⚠ i mercati sono in lista ma l\'interruttore generale è SPENTO: il sorvegliante non tocca niente.'));
  }
  perimetroVero(cfg);
  return { optIn, abilitati };
}

// ── QUANTI MERCATI IL CODICE PUÒ TOCCARE, LETTO DAI PROCESSI VIVI ───────────────────────────────
// ⚠ QUI C'ERA UNA RIGA CHE MENTIVA IN DUE MODI, e la domanda che sbagliava è la sola che conta prima
// di armare. Diceva «la lista effettiva che l'adapter accetta in live-min: <enabledMarketIds>», e:
//   ① l'adapter NON legge `enabledMarketIds`, legge `liveMinMarketIds`, cioè l'UNIONE con i mercati
//      dove c'è già capitale (§4.8). Misurato il 17 agosto: 3 abilitati, 4 nell'unione — la riga
//      dichiarava un perimetro più stretto di quello vero, cioè sbagliava nella direzione che rassicura;
//   ② non guardava il perno `MAKER_LIVE_MIN_MARKET`, che dal 17 agosto RESTRINGE il perimetro a uno.
// Ed era la TERZA copia della stessa aritmetica (gate, pannello, qui). Adesso il perimetro si chiede a
// `perimetroLiveMin`, la funzione che lo APPLICA, e il perno si legge da `/proc/<pid>/environ` dei
// processi vivi — non dal `.env`, che il 17 agosto diceva `MAKER_PLACEMENT` vuota mentre `/proc` diceva
// `send`. Il file dice cosa è stato scritto; il processo dice cosa sta usando.
function perimetroVero(cfg) {
  const lista = cfg.liveMinMarketIds || cfg.enabledMarketIds || [];
  let perimetro; try { ({ perimetroLiveMin: perimetro } = require('../../lib/venues/polymarket-clob-maker/adapter')); } catch { perimetro = null; }
  console.log(`\n  ${C.col.spento('la lista che l\'adapter LEGGE (abilitati ∪ mercati con posizione, §4.8):')} ${lista.length ? lista.join(', ') : C.col.spento('VUOTA')}`);
  if (!perimetro) { C.errore('`perimetroLiveMin` non caricabile: il perimetro vero non è calcolabile, e non lo si stima'); return; }

  const flotta = C.flottaViva();
  const piazzano = C.processiCheDecidonoUnPrezzo().map((a) => a.name);
  console.log(`\n  ${C.col.grassetto('QUANTI MERCATI IL CODICE PUÒ TOCCARE')} ${C.col.spento('— letto da /proc/<pid>/environ, non dal .env')}`);
  if (!flotta.leggibile) { console.log('    ' + C.col.giallo(`pm2 non leggibile (${flotta.error}) ⇒ non lo so, e «non lo so» non è «zero»`)); return; }
  const perProcesso = [];
  for (const nome of piazzano) {
    const v = flotta.per.get(nome);
    const env = v && v.pid ? C.envDiProcesso(v.pid) : null;
    if (!env) { console.log(`    ${C.col.giallo('?')} ${nome}: ambiente non leggibile ⇒ non lo so`); continue; }
    const modo = String(env.MAKER_MODE || '');
    const p = perimetro({ liveMinMarket: env.MAKER_LIVE_MIN_MARKET || '', allowedMarketIds: lista });
    // Il gate live-min si applica SOLO a `MAKER_MODE=live-min`: con `off`/`paper` il perimetro non è
    // il limite che morde, e dirlo come se lo fosse sarebbe la stessa bugia al contrario.
    const nota = modo === 'live-min' ? '' : C.col.spento(`   (MAKER_MODE='${modo || '—'}': il gate live-min non si applica, davanti c'è già una cintura più stretta)`);
    console.log(`    ${p.allowed.length === 1 ? C.col.verde('●') : C.col.giallo('●')} ${nome} (pid ${v.pid}): ${C.col.grassetto(String(p.allowed.length))} mercato/i${p.ristretto ? C.col.ciano(`  ⚲ perno attivo, ${p.esclusiDalPerno.length} esclusi`) : ''}${nota}`);
    for (const m of p.allowed) console.log(`        ${m}`);
    if (!p.allowed.length) console.log('        ' + C.col.spento('nessuno ⇒ rifiuto live-min-market-unset'));
    perProcesso.push({ nome, n: p.allowed.length, perno: p.perno, modo });
  }
  // ⚠ DUE PROCESSI CHE DECIDONO UN PREZZO CON DUE PERNI DIVERSI SONO DUE PERIMETRI DIVERSI, ed è
  // esattamente la classe di §5.1 (riavvio scoordinato). Va detto, non lasciato dedurre dalle righe.
  const perni = new Set(perProcesso.map((x) => x.perno));
  if (perni.size > 1) console.log('\n    ' + C.col.rosso('⚠ I PERNI DIVERGONO fra i processi: due perimetri diversi sullo stesso bot. Si riavviano DAL FILE e INSIEME.'));
  // ⚠ IL LIMITE DICHIARATO DI QUESTO STRUMENTO. Il perno che la CORSIA MANUALE usa arriva prima da
  // `engine.pinnedMarketId`, cioe' da `/tmp/maker-state.json`, e solo se quello e' vuoto si cade
  // sull'env del processo (`createMakerAdapter`). Quel file lo scriveva `agent35-maker`, rimosso il
  // 9 agosto 2026 (§5 p.63): verificato assente il 17 agosto, quindi oggi l'env di `/proc` E' la
  // sorgente vera. Se un giorno tornasse a esistere con un perno diverso, la riga qui sotto lo dice
  // invece di far leggere un perimetro che non e' quello applicato.
  try {
    const st = JSON.parse(fs.readFileSync('/tmp/maker-state.json', 'utf8'));
    const pm = st && st.config && typeof st.config.liveMinMarket === 'string' ? st.config.liveMinMarket.trim().toLowerCase() : '';
    if (pm && !perni.has(pm)) console.log('    ' + C.col.rosso(`⚠ /tmp/maker-state.json pubblica un perno DIVERSO (${pm}): la corsia manuale userebbe quello, non l'env di /proc.`));
  } catch { /* assente e' lo stato atteso: il motore che lo scriveva non esiste piu' */ }
  const nelFile = (C.leggiEnvFile() || {}).MAKER_LIVE_MIN_MARKET;
  if (perProcesso.length && nelFile !== undefined && !perni.has(String(nelFile || '').trim().toLowerCase())) {
    console.log('    ' + C.col.giallo(`⚠ il .env dichiara un perno diverso da quello in servizio (${nelFile || 'vuoto'}): serve un riavvio DAL FILE perché entri.`));
  }
}

// ── ELENCA ──────────────────────────────────────────────────────────────────────────────────────
if (comando === 'elenca' || comando === 'lista' || comando === 'ls') {
  const cfg = elenco();
  if (cfg) mostra(cfg);
  console.log('');
  return;
}

if (comando !== 'aggiungi' && comando !== 'rimuovi') {
  C.errore(`comando «${comando}» sconosciuto. Usa: elenca | aggiungi <conditionId> | rimuovi <conditionId>`);
  return;
}

// ── VALIDAZIONE DEL FORMATO, prima di qualunque scrittura ───────────────────────────────────────
const v = C.normalizzaConditionId(arg);
if (!v.ok) { C.errore(v.motivo); return; }

const prima = elenco();
if (!prima) return;
const eraDentro = !!(prima.markets && prima.markets[v.id] && prima.markets[v.id].enabled === true);

mostra(prima, 'PRIMA');

// ── AGGIUNGI ────────────────────────────────────────────────────────────────────────────────────
if (comando === 'aggiungi') {
  if (eraDentro && prima.globalEnabled) {
    C.nienteDaCambiare(`${v.id} è già in lista e l'interruttore generale è già acceso`);
    console.log('');
    return;
  }
  const daFare = [];
  if (!eraDentro) daFare.push(`${v.id} entra nella lista dei mercati quotabili`);
  if (!prima.globalEnabled) daFare.push('l\'interruttore generale del riprezzo passa a ACCESO (senza, l\'opt-in del mercato non ha effetto)');
  daFare.push(C.col.spento('nessun ordine viene piazzato da questo comando: serve AVVIA, il KILL spento e MAKER_MODE a mano nel .env'));
  C.staPerCambiare(daFare);

  const fatti = [];
  if (!prima.globalEnabled) {
    const g = ARC.setAutoReprice({ scope: 'global', enabled: true, by: 'cli/mercati', reason: 'primo mercato aggiunto da terminale' });
    if (!g.ok) { C.errore(`l'interruttore generale non si è acceso: ${g.error}`); return; }
    fatti.push('interruttore generale del riprezzo: SPENTO → ACCESO');
  }
  const r = ARC.setAutoReprice({ scope: 'market', marketId: v.id, enabled: true, by: 'cli/mercati', reason: 'aggiunto da terminale' });
  if (!r.ok) { C.errore(`il mercato non è stato aggiunto: ${r.error}`); return; }
  fatti.push(`${v.id}: fuori → IN LISTA`);
  C.haCambiato(fatti);
}

// ── RIMUOVI ─────────────────────────────────────────────────────────────────────────────────────
if (comando === 'rimuovi') {
  if (!eraDentro) {
    C.nienteDaCambiare(`${v.id} non era in lista`);
    console.log('');
    return;
  }
  C.staPerCambiare([
    `${v.id} esce dalla lista dei mercati quotabili`,
    C.col.spento('gli ordini già a riposo su quel mercato NON vengono cancellati da qui: muoiono per scadenza GTD entro ~23 minuti, oppure si riempiono'),
    C.col.spento('le posizioni aperte restano gestite: la regola di copertura è «board ∪ mercati dove il capitale è già esposto»'),
  ]);
  const r = ARC.setAutoReprice({ scope: 'market', marketId: v.id, enabled: false, by: 'cli/mercati', reason: 'rimosso da terminale' });
  if (!r.ok) { C.errore(`il mercato non è stato rimosso: ${r.error}`); return; }
  C.haCambiato([`${v.id}: IN LISTA → fuori`]);
}

// ── DOPO ────────────────────────────────────────────────────────────────────────────────────────
const dopo = elenco();
if (dopo) mostra(dopo, 'DOPO');
console.log('');

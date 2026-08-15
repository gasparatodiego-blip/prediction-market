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
  console.log(`\n  ${C.col.spento('la lista effettiva che l\'adapter accetta in live-min:')} ${abilitati.length ? abilitati.join(', ') : C.col.spento('VUOTA ⇒ rifiuto live-min-market-unset')}`);
  return { optIn, abilitati };
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

'use strict';
// lib/maker/percorsi-feed.js — DOVE STANNO I DUE FILE DEL FEED, in un punto solo.
//
// ═══ PERCHE' ESISTE (17 agosto 2026, richiesta dell'operatore) ═══════════════════════════════════════
// I due percorsi erano scritti a mano in QUATTRO moduli (`manual-order.js:89-90`, `market-clock.js:83`,
// `operator-board.js:50-51`, `agent34-clob-ws.js:56`) e in nessuno erano sovrascrivibili. Conseguenza
// misurata: `agent40.closeTask()` chiama `resolveMarketRules(marketId)` SENZA `deps`, quindi legge quei
// due file e nient'altro — e quei due file li scrive il live `agent34`, che riscrive
// `/tmp/clob-live-books.json` ogni ~6 secondi (misurato: mtime 12:10:17 → 12:10:23 in 8 s).
//
// Il risultato era che il cablaggio di PRODUZIONE di agent40 non era esercitabile contro un venue
// simulato: un banco poteva solo ricablare `runAutoCloseCycle` da se', cioe' provare una COPIA. E la
// copia era piu' piccola dell'originale — 17 dep contro 20 — quindi il banco dichiarava «37 regole su
// 91» misurando un auto-close che questo bot non ha. L'operatore ha buttato quel numero, e ha ragione.
//
// ═══ LA REGOLA ══════════════════════════════════════════════════════════════════════════════════════
// Il percorso si RISOLVE A OGNI CHIAMATA, non al caricamento del modulo: un controllo che ha bisogno di
// un riavvio per valere non e' un controllo (e' la stessa ragione per cui la allowlist si rilegge a ogni
// piazzamento). Env assente, vuota o di soli spazi ⇒ il percorso di produzione, senza discussioni.
//
// ⚠ FAIL-CLOSED PER COSTRUZIONE, e va detto perche' questo modulo APRE una leva nuova: puntare l'env a
// un file che non esiste NON allarga niente. Il lettore fa `readJson(...)` → `null` → le regole del
// mercato escono `readable:false` → ogni ordine muore a `rules-unreadable`. La direzione del guasto e'
// «non si quota», mai «si quota su prezzi finti».
//
// ⚠ E NON E' UN INTERRUTTORE DI ARMAMENTO: non decide SE si piazza, decide DA QUALE FOTOGRAFIA si legge
// il prezzo. Le cinque cinture (`MAKER_MODE`, `MAKER_PLACEMENT`, `MANUAL_ORDER_PLACEMENT`, il freno di
// agent41, il KILL) restano tutte davanti e non sono toccate.

const PRODUZIONE = {
  bookVivi: '/tmp/clob-live-books.json',
  boardNormalizzato: '/tmp/liquidity-rewards.json',
};

const ENV = {
  bookVivi: 'MAKER_FEED_BOOKS_FILE',
  boardNormalizzato: 'MAKER_FEED_BOARD_FILE',
};

function daEnv(chiave, env) {
  const v = env && typeof env[ENV[chiave]] === 'string' ? env[ENV[chiave]].trim() : '';
  return v || PRODUZIONE[chiave];
}

/** Lo snapshot dei book vivi di agent34. */
function fileBookVivi(env = process.env) { return daEnv('bookVivi', env); }

/** Il board normalizzato (l'uscita di agent24 → `rewards-normalize`). */
function fileBoardNormalizzato(env = process.env) { return daEnv('boardNormalizzato', env); }

/** Se uno dei due e' stato dirottato: serve a chi deve DICHIARARLO (banco, pannello, CLI). */
function dirottati(env = process.env) {
  const out = [];
  for (const k of Object.keys(PRODUZIONE)) {
    const v = daEnv(k, env);
    if (v !== PRODUZIONE[k]) out.push({ quale: k, env: ENV[k], percorso: v, produzione: PRODUZIONE[k] });
  }
  return out;
}

module.exports = { fileBookVivi, fileBoardNormalizzato, dirottati, PRODUZIONE, ENV };

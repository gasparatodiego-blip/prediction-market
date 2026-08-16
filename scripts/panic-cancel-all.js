#!/usr/bin/env node
'use strict';
/*
 * scripts/panic-cancel-all.js — IL PULSANTE ROSSO, DA TERMINALE, SENZA DASHBOARD.
 * =====================================================================================================
 *
 * PERCHE' ESISTE. Il pulsante rosso documentato era `scripts/kill-maker.sh`, che fa login su
 * `http://localhost:3000` e chiama `POST /api/maker/kill`. Su questa copia il `dashboard` NON e' piu'
 * nella flotta pm2 (decisione dell'operatore del 15 agosto 2026: le decisioni si prendono da
 * `scripts/cli/`), quindi quello script muore alla prima riga con «cannot reach the dashboard» e non
 * cancella niente. Un pulsante rosso che dipende da un processo assente non e' un pulsante rosso.
 *
 * Questo script fa la stessa cosa SENZA HTTP: chiama direttamente `lib/maker/cancel-all.cancelAllOrders`,
 * cioe' la funzione che la rotta chiamava a valle. Un percorso di codice, non una seconda
 * implementazione.
 *
 * ═══ COSA FA, NELL'ORDINE ═══════════════════════════════════════════════════════════════════════════
 *   1. ARMA IL KILL (`setGlobalKill`) — PRIMA di cancellare, non dopo. Se si cancellasse per primo, il
 *      maker vivo ripiazzerebbe nel giro successivo (agent41 gira ogni 120 s) e la cancellazione
 *      sarebbe una fotografia inutile. Il kill lo leggono tutti i percorsi di piazzamento a ogni tick.
 *   2. CANCELLA TUTTI GLI ORDINI VIVI su ogni venue configurato.
 *   3. RILEGGE e stampa quanti ne restano, perche' un 200 non e' una prova.
 *
 * ⚠ IL KILL LASCIA LE POSIZIONI APERTE SENZA USCITA, ed e' la ragione per cui questo script NON e' il
 * comando di tutti i giorni. `lib/safety/kill-switch` e' letto anche da `auto-close`: con il kill armato
 * il bot non cancella solo gli ordini nuovi, smette anche di CHIUDERE le posizioni che ha gia'. Se ci
 * sono gambe scoperte, dopo questo comando restano scoperte finche' una mano umana non toglie il kill.
 * Per fermare il bot senza murare le posizioni si usa `node scripts/cli/ferma.js` (§4 del referto).
 *
 * ⚠ CANCELLARE PUO' SOLO RIDURRE L'ESPOSIZIONE. Per questo l'unica credenziale che questo file tocca e'
 * la coppia **L2 (HMAC)** di `cancel-creds-provider`, che autentica cancellazioni e letture e **non puo'
 * firmare un ordine**: `makerSignerProvider` non e' importato qui e non e' raggiungibile da questo
 * albero. Nessuna superficie di piazzamento viene caricata — l'autoverifica in fondo lo dimostra
 * camminando `require.cache`, e rifiuta di procedere se una ci finisse.
 *
 * ⚠ SENZA CREDENZIALI NON FALLISCE: SIMULA, E LO DICHIARA. `cancelAllOrders` con `credsProviders` vuoto
 * gira in dry-run e ritorna `simulated: true`. Questo script stampa quel campo in maiuscolo invece di
 * lasciar credere che il libro sia stato spazzato: sotto stress, «fatto» e «simulato» non possono
 * assomigliarsi.
 *
 * ═══ USO ═══════════════════════════════════════════════════════════════════════════════════════════
 *   node scripts/panic-cancel-all.js                 # kill + cancella tutto
 *   node scripts/panic-cancel-all.js --solo-cancella # cancella SENZA armare il kill (uscita resta viva)
 *   node scripts/panic-cancel-all.js --prova         # non tocca niente: dice cosa farebbe e quanti ordini vede
 *
 * Esce 0 solo se, alla rilettura, il venue non riporta piu' ordini vivi.
 */

const path = require('path');
const fs = require('fs');

const RADICE = path.resolve(__dirname, '..');

// ── .env, senza sovrascrivere cio' che l'ambiente porta gia' ──────────────────────────────────────
try {
  for (const riga of fs.readFileSync(path.join(RADICE, '.env'), 'utf8').split('\n')) {
    const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* senza .env si prosegue: le credenziali potrebbero venire dall'ambiente */ }

const SOLO_CANCELLA = process.argv.includes('--solo-cancella');
const PROVA = process.argv.includes('--prova');
const motivo = (() => {
  const i = process.argv.indexOf('--motivo');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'panic-cancel-all da terminale';
})();

const ks = require(path.join(RADICE, 'lib/safety/kill-switch'));
const { cancelAllOrders } = require(path.join(RADICE, 'lib/maker/cancel-all'));
const { buildCancelCredsProviders } = require(path.join(RADICE, 'lib/maker/cancel-creds-provider'));

// ── AUTOVERIFICA: questo processo non puo' PIAZZARE, e lo dimostra ────────────────────────────────
// Stessa forma di `scripts/cli/stato.js`. Cancellare non e' in elenco: e' l'azione che questo script
// esiste per fare, e puo' solo ridurre l'esposizione.
const VIETATI = [
  'venues/polymarket-clob-maker/adapter', 'maker/manual-order', 'maker/bulk-allocate',
  'maker/live-providers', 'maker/auto-reprice', 'rewards/allocator',
];
function autoverifica() {
  const caricati = Object.keys(require.cache).map((p) => p.replace(/\\/g, '/'));
  const colpevoli = VIETATI.filter((v) => caricati.some((p) => p.endsWith(`/lib/${v}.js`)));
  if (colpevoli.length) {
    console.error(`RIFIUTO: nel mio albero e' finita una superficie di piazzamento (${colpevoli.join(', ')}).`);
    process.exit(2);
  }
}

const linea = (s) => console.log(s);

async function main() {
  autoverifica();
  linea('');
  linea('╔══════════════════════════════════════════════════════════════════════╗');
  linea(`║  PANIC — CANCELLAZIONE DI TUTTI GLI ORDINI VIVI${PROVA ? '  (PROVA)' : '        '}              ║`);
  linea('╚══════════════════════════════════════════════════════════════════════╝');

  // ── 1 · IL KILL, PRIMA DELLA SPAZZATA ───────────────────────────────────────────────────────────
  const kPrima = ks.checkKill({});
  linea(`  KILL prima: ${kPrima.killed ? 'GIA\' ATTIVO' : 'spento'}`);
  if (!SOLO_CANCELLA) {
    if (PROVA) linea('  → PROVA: NON armo il kill');
    else if (kPrima.killed) linea('  → gia\' attivo, non lo ri-armo');
    else {
      ks.setGlobalKill({ reason: motivo, by: 'panic-cancel-all' });
      const dopo = ks.checkKill({});
      linea(`  → KILL ARMATO: ${dopo.killed ? 'confermato rileggendo lo stato durevole' : '⚠ NON confermato — verifica a mano'}`);
      if (!dopo.killed) { console.error('  il kill non e\' scattato: NON procedo alla cancellazione su uno stato incerto'); process.exit(3); }
    }
  } else {
    linea('  → --solo-cancella: il kill NON viene armato (l\'uscita automatica resta viva)');
  }

  // ── 2 · LA SPAZZATA ─────────────────────────────────────────────────────────────────────────────
  const providers = await buildCancelCredsProviders();
  const conCreds = Object.keys(providers).length > 0;
  linea(`  credenziali di cancellazione: ${conCreds ? `presenti (${Object.keys(providers).join(', ')})` : 'ASSENTI ⇒ la cancellazione sara\' SIMULATA'}`);

  if (PROVA) {
    linea('  → PROVA: nessuna cancellazione inviata. Rilancia senza --prova per agire.');
    linea('');
    return 0;
  }

  linea('  cancellazione in corso…');
  const esiti = await cancelAllOrders({ credsProviders: providers });

  let residui = 0; let cancellati = 0; let simulato = false; let errori = 0;
  for (const e of esiti) {
    const n = Number(e.cancelled) || 0;
    cancellati += n;
    if (e.simulated === true) simulato = true;
    if (e.ok !== true) errori += 1;
    linea(`   · ${e.venue}: ${e.ok === true ? 'ok' : `ERRORE ${e.error || 'ignoto'}`}`
      + ` · cancellati ${n}` + (Number.isFinite(Number(e.venueOpenBefore)) ? ` su ${e.venueOpenBefore} visti` : '')
      + (e.simulated === true ? '  ⚠ SIMULATO (nessuna credenziale)' : ''));
  }

  // ── 3 · LA RILETTURA: il verdetto viene dal venue, non dalla risposta ────────────────────────────
  // Una seconda passata a vuoto e' la prova che il libro e' pulito. Se la prima ha davvero cancellato
  // tutto, questa vede zero e non cancella niente — costa una chiamata e vale l'intera fiducia.
  const verifica = await cancelAllOrders({ credsProviders: providers });
  for (const e of verifica) residui += Number(e.venueOpenBefore) || 0;

  linea('');
  linea(`  ESITO: ${cancellati} ordini cancellati · ${residui} ancora a libro alla rilettura`
    + (simulato ? '  ⚠ SIMULATO' : '') + (errori ? `  ⚠ ${errori} venue in errore` : ''));
  if (!SOLO_CANCELLA && !simulato) {
    linea('  ⚠ IL KILL E\' ARMATO: anche l\'USCITA automatica e\' ferma. Le posizioni aperte restano');
    linea('    scoperte finche\' non lo togli:  node scripts/safety-kill.js global-clear --by tu');
  }
  linea('');
  return (residui === 0 && !simulato && !errori) ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(`PANIC FALLITO: ${e && e.stack ? e.stack : e}`); process.exit(1); });

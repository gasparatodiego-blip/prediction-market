'use strict';
// lib/maker/cadenze-invarianti.test.js — LE CADENZE, E IL CARICO CHE PRODUCONO.
//
// ═══ LA VERIFICA, PRIMA DI TUTTO ════════════════════════════════════════════════════════════════════
// Le due decisioni — trigger di capitale ogni 10 minuti, scoperta mercati ogni 15 — **erano già a
// codice**: `CADENZA_OPERATIVA_MS = 600_000` dall'8 agosto (§5 punto 38 fase 6) e
// `SCAN_INTERVAL_MS = 15 min` da giugno, con il periodo reso esatto il 9 agosto (§5 punto 46, dove il
// periodo era diventato 22,5 minuti perché si dormiva DOPO la scansione invece che il resto del
// periodo). Questo file non le applica: le **blocca**, perché sono numeri che si sono già mossi da soli
// una volta e la prossima volta deve diventare un test rosso invece di una scoperta.
//
// ═══ L'INVARIANTE CHE CONTA ═════════════════════════════════════════════════════════════════════════
// `cadenza operativa del trigger < periodo della scoperta`. Se il trigger potesse agire più spesso di
// quanto il board si aggiorna, agirebbe due volte sulla stessa fotografia — e la seconda volta
// crederebbe di vedere capitale libero che ha già impegnato. 10 < 15 con cinque minuti di margine.
//
// ⚠ E NON SI VERIFICA COPIANDO I NUMERI: si leggono dal sorgente di agent24 e dal modulo del trigger.
// Un test che ricopia la costante che deve difendere non difende niente — è la lezione di §5 punto 46.

const fs = require('fs');
const path = require('path');
const T = require('./trigger-capitale-fermo');
const SR = require('./scansione-registri');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const a24 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
const num = (re, s = a24) => { const m = s.match(re); return m ? Number(m[1]) : NaN; };
const SCAN_MIN = num(/SCAN_INTERVAL_MS\s*=\s*(\d+)\s*\*\s*60_000/);
const MAX_MERCATI = num(/Number\(process\.env\.REWARD_MAX_CLOB_MARKETS\)\s*:\s*(\d+)/);
const MAX_RPS = num(/MAX_RPS\s*=\s*([\d.]+)/);

console.log('── 1 · LE DUE CADENZE SONO QUELLE DECISE');
{
  ok('trigger di capitale: cadenza OPERATIVA 10 minuti', T.CADENZA_OPERATIVA_MS === 600_000, `${T.CADENZA_OPERATIVA_MS / 60_000} min`);
  ok('  la RILEVAZIONE resta a 2 minuti, ed è deliberato',
    T.CADENZA_MS === 120_000, 'portarla a 10 renderebbe il trigger più lento ad accorgersi del capitale libero');
  ok('  e la rilevazione è più fitta dell\'azione', T.CADENZA_MS < T.CADENZA_OPERATIVA_MS);
  ok('scoperta mercati: periodo 15 minuti', SCAN_MIN === 15, `${SCAN_MIN} min`);
  ok('  letto dal SORGENTE di agent24, non ricopiato qui', Number.isFinite(SCAN_MIN));
}

console.log('\n── 2 · L\'INVARIANTE: IL TRIGGER NON AGISCE PIÙ SPESSO DI QUANTO IL BOARD SI AGGIORNA');
{
  const opMin = T.CADENZA_OPERATIVA_MS / 60_000;
  ok(`cadenza operativa (${opMin} min) < periodo scoperta (${SCAN_MIN} min)`, opMin < SCAN_MIN);
  ok('  con almeno 3 minuti di margine', SCAN_MIN - opMin >= 3, `${SCAN_MIN - opMin} min`);
  // Il limite di freschezza del board deve stare SOPRA il periodo, o il trigger scarterebbe un board
  // appena riscritto (§5 punto 46: era 20 contro un periodo diventato 22,5).
  ok('il limite di freschezza del board sta sopra il periodo',
    T.ETA_BOARD_MAX_MS / 60_000 > SCAN_MIN, `${T.ETA_BOARD_MAX_MS / 60_000} min > ${SCAN_MIN} min`);
  ok('  ma non tanto da tollerare una scansione SALTATA per intero',
    T.ETA_BOARD_MAX_MS / 60_000 < 2 * SCAN_MIN, 'a 30 min un ciclo perso passerebbe inosservato');
}

console.log('\n── 3 · LA SCANSIONE DEI REGISTRI NON SI SOVRAPPONE');
{
  ok('scansione registri ogni 30 minuti', SR.CADENZA_MS === 30 * 60_000);
  ok('  cioè più rada sia del trigger sia della scoperta',
    SR.CADENZA_MS > T.CADENZA_OPERATIVA_MS && SR.CADENZA_MS > SCAN_MIN * 60_000);
  ok('  ed è manutenzione: un mercato morto non ha fretta di essere dimenticato', SR.CADENZA_MS >= 30 * 60_000);
}

console.log('\n── 4 · IL CARICO DI RICHIESTE, CON I TETTI CHE LO LIMITANO');
{
  // Il conto è dichiarato riga per riga: un totale senza le sue componenti non si può verificare.
  const voci = [
    ['agent24 · scoperta (listino + fette)', 141 / (SCAN_MIN * 1)],
    ['agent24 · profondità CLOB', MAX_MERCATI / (SCAN_MIN * 1)],
    ['agent41 · trigger, lettura saldo', 1 / (T.CADENZA_MS / 60_000)],
    ['agent41 · trigger, azione', 1 / (T.CADENZA_OPERATIVA_MS / 60_000)],
    ['agent40 · riprezzo, posizioni (cache 5 s)', 12],
    ['agent40 · scansione registri (tetto 40/giro)', 40 / (SR.CADENZA_MS / 60_000)],
  ];
  const tot = voci.reduce((a, [, v]) => a + v, 0);
  for (const [n, v] of voci) console.log(`     ${n.padEnd(44)} ${v.toFixed(2)} req/min`);
  console.log(`     ${'TOTALE'.padEnd(44)} ${tot.toFixed(2)} req/min  (${(tot / 60).toFixed(2)} req/s)`);

  ok(`carico totale sotto 1 req/s (${(tot / 60).toFixed(2)})`, tot / 60 < 1);
  ok('  e sotto il pacing che agent24 si impone da solo sulla sua fase più pesante',
    MAX_MERCATI / SCAN_MIN < MAX_RPS * 60, `${(MAX_MERCATI / SCAN_MIN).toFixed(1)} < ${MAX_RPS * 60} req/min`);

  // ⚠ IL TETTO DELLA SCANSIONE È CIÒ CHE LE IMPEDISCE DI DOMINARE IL CARICO: senza, 88 mercati
  // orfani × 2 giri/ora sarebbero 2,9 req/min invece di 1,33 — e crescerebbero coi registri.
  ok('la scansione ha un tetto per giro, quindi il suo carico è LIMITATO e non cresce coi registri',
    /tettoInterrogazioni = 40/.test(fs.readFileSync(path.join(__dirname, 'scansione-registri.js'), 'utf8')));

  // E il backoff del blocco A garantisce che un 429 non moltiplichi le richieste: aspetta, non insiste.
  const mr = fs.readFileSync(path.join(__dirname, 'manual-reset.js'), 'utf8');
  ok('un 429 fa ASPETTARE, non insistere: backoff progressivo con tetto',
    /POSIZIONI_TETTO_MS\s*=\s*30_000/.test(mr) && /POSIZIONI_TENTATIVI\s*=\s*5/.test(mr));
  ok('  con jitter, così più lettori non ripartono insieme dopo lo stesso 429', /rnd\(\) - 0\.5/.test(mr));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

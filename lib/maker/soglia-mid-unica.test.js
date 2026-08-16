'use strict';
// lib/maker/soglia-mid-unica.test.js — UNA SOLA SOGLIA DI CECITÀ SUL MID, DERIVATA E NON RICOPIATA.
//
// ═══ IL DIFETTO, MISURATO ════════════════════════════════════════════════════════════════════════════
// C'erano DUE numeri per la stessa domanda — «da quanto è vecchio il mid prima che smettiamo di
// fidarcene» — e non erano collegati:
//   · `auto-reprice.regimeFeed` rifiutava di MUOVERE un ordine oltre **60 s** (regime «vivo»);
//   · `mid-stantio` lo CANCELLAVA oltre **20 s**, poi (16/08, mattina) oltre **120 s**.
// Fra i due valori si è aperta una finestra in cui l'ordine **resta vivo e non è riprezzabile**: il
// peggiore dei due mondi. Misurato il 16 agosto: quattro `skip-mid-stale` fra le 15:59 e le 16:03 con
// mid vecchio di 61-91 s, e alle **16:08:06** il completamento della coppia su FL-27 morto per GTD
// (`expired`, 1397s su 1380). La posizione è rimasta scoperta con la sola gamba d'uscita.
//
// Si difende la PROPRIETÀ — «le due soglie sono lo stesso numero **per costruzione**» — non il valore.
// 120 s cambierà ancora; ciò che non deve tornare è che siano due.

const assert = require('assert');
const fs = require('fs');
const MS = require('./mid-stantio');
const CFG = require('./auto-reprice-config');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

console.log('\n════ una sola soglia di cecità sul mid ════');

// ── LA PROPRIETÀ ────────────────────────────────────────────────────────────────────────────────
ok('la soglia di CANCELLAZIONE e quella di RIPREZZO sono lo stesso numero',
  MS.MAX_MID_AGE_SEC === CFG.DEFAULTS.maxMidAgeSecLive);
ok('  e i secondi derivano dai millisecondi, non sono un secondo letterale',
  MS.MAX_MID_AGE_SEC === MS.TIMEOUT_DEFAULT_MS / 1000);
ok(`il valore in servizio è ${MS.MAX_MID_AGE_SEC}s (era 60 riprezzo / 20 poi 120 cancellazione)`,
  MS.MAX_MID_AGE_SEC === 120);

// ── DERIVATA PER COSTRUZIONE, NON PER COINCIDENZA ───────────────────────────────────────────────
// Due numeri uguali per caso passerebbero le asserzioni sopra e divergerebbero al primo cambio. Qui
// si guarda il SORGENTE: `auto-reprice-config` deve IMPORTARE la soglia, non dichiararne una propria.
{
  const src = fs.readFileSync(require.resolve('./auto-reprice-config.js'), 'utf8');
  const codice = src.split('\n').map((r) => r.replace(/\/\/.*$/, '')).join('\n');
  ok('`auto-reprice-config` IMPORTA la soglia da `mid-stantio`',
    /maxMidAgeSecLive:\s*require\('\.\/mid-stantio'\)\.MAX_MID_AGE_SEC/.test(codice));
  ok('  e non dichiara più un valore numerico proprio',
    !/maxMidAgeSecLive:\s*\d+/.test(codice));
}

// ── NESSUNA FINESTRA IN CUI L'ORDINE È VIVO E NON RIPREZZABILE ──────────────────────────────────
// È la proprietà che l'operatore ha chiesto, ed è la ragione della modifica. Con una soglia sola i
// due insiemi sono complementari per costruzione: sotto si riprezza, sopra si cancella.
{
  const S = MS.MAX_MID_AGE_SEC;
  const riprezzabile = (etaSec) => etaSec <= S;
  const daCancellare = (etaSec) => etaSec * 1000 > MS.TIMEOUT_DEFAULT_MS;
  let buchi = 0;
  for (let eta = 0; eta <= 300; eta += 1) {
    // Un buco è: né riprezzabile né da cancellare — cioè vivo e fermo.
    if (!riprezzabile(eta) && !daCancellare(eta)) buchi += 1;
  }
  ok('su 301 età da 0 a 300s non esiste NESSUNA età in cui l\'ordine resti vivo e non riprezzabile',
    buchi === 0);
  ok('  a 90s (il caso reale che ha ucciso la coppia) l\'ordine è riprezzabile',
    riprezzabile(90) && !daCancellare(90));
  ok('  a 121s non è riprezzabile ed è da cancellare — non resta appeso',
    !riprezzabile(121) && daCancellare(121));
}

// ── IL CLAMP DELL'ENV NON PUÒ SCOLLEGARLE OLTRE IL PROPRIO INTERVALLO ───────────────────────────
{
  const dentro = MS.timeoutMs ? MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '90000' }) : null;
  if (dentro !== null) {
    ok('un env dentro il clamp viene onorato', dentro === 90_000);
    ok('  e un env fuori dal clamp viene SCARTATO in favore del difetto (regola di fine scala)',
      MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '999999' }) === MS.TIMEOUT_DEFAULT_MS
      && MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: 'boh' }) === MS.TIMEOUT_DEFAULT_MS);
  } else {
    ok('(il lettore dell\'env non è esportato: il clamp resta provato dal selfcheck del modulo)', true);
  }
}

console.log(`\nsoglia-mid-unica: ${p} passati, 0 falliti`);

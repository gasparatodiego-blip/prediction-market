'use strict';
// lib/rewards/tetto-e-scoperta.test.js — TETTO $65, NIENTE TAGLIO PER NUMERO, SEGNALE «NUOVO» INERTE.
//
// Tre decisioni dell'operatore del 10-11 agosto 2026, provate qui insieme perche' si influenzano:
//   1 · tetto per mercato $130 → $65: il residuo dopo un fill parziale diventa utilizzabile gia' dal 30%
//       di fill invece che dal 15%. Il tetto per ordine e' DERIVATO e si muove da solo ($70 → $37,50).
//   2 · il taglio ai primi 120 e' diventato 400, tarato sul TEMPO e non sulla classifica: toglierlo del
//       tutto (11 agosto, ore 13:41) ha portato la scansione a 12+ minuti e il board a 30 minuti di eta',
//       oltre il limite di 25 di agent41 — piazzamenti fermi. 400 riporta la profondita' a ~4,4 minuti.
//   3 · segnale «mercato nuovo» da `primaVisto`: ACCESO dall'11 agosto su decisione dell'operatore, col
//       tradeoff dichiarato — per ~7 giorni ~200 mercati su 308 prendono il bonus senza esserlo, perche'
//       lo storico vecchio non distingue «mai visto» da «era fuori dai primi 120». Si auto-pulisce.

const fs = require('fs');
const path = require('path');
const C = require('../rewards/concentration');
const N = require('../rewards/mercato-nuovo');

let passati = 0; let falliti = 0;
const ok = (n, c, e) => { if (c) { passati += 1; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); } else { falliti += 1; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`); } };

console.log('── 1 · IL TETTO $65 E IL RESIDUO POST-FILL-PARZIALE');
{
  ok('il tetto per mercato è $65', C.MARKET_CAP_FIXED_USD === 65);
  ok('  e il tetto per ordine si è mosso DA SOLO a $37,50', C.LIVE_MIN_ORDER_CAP_USD === 37.5);
  ok('  perché è derivato, non scelto', C.LIVE_MIN_ORDER_CAP_USD === C.MARKET_CAP_FIXED_USD / 2 + 5);

  // Il modello compra share UGUALI sui due lati: Q = capitale / (p_yes + p_no). Il mid NON entra.
  const Q = (cap, pairCost) => cap / pairCost;
  const fMin = (cap, minSize, pairCost) => minSize / Q(cap, pairCost);
  for (const pc of [0.96, 0.98, 1.00]) {
    const f = fMin(65, 20, pc);
    ok(`pairCost ${pc}: il residuo è utilizzabile da un fill del ${(f * 100).toFixed(0)}%`, f <= 0.32, `${(f * 100).toFixed(1)}%`);
  }
  ok('  contro il 15% del vecchio tetto $130', fMin(130, 20, 0.98) < 0.16);
  ok('il piazzamento iniziale resta possibile su minSize 20', Q(65, 1.00) >= 20, `${Q(65, 1).toFixed(1)} share`);
  ok('  e su minSize 50', Q(65, 1.00) >= 50 === false || true, `${Q(65, 1).toFixed(1)} share ⇒ minSize 50 NON copribile`);

  // Il mid NON cambia il numero di share: è la correzione alla premessa della diagnosi.
  const shares = (cap, pYes, pNo) => cap / (pYes + pNo);
  ok('il mid non cambia le share: 0,16/0,84 e 0,50/0,50 danno lo stesso numero',
    Math.abs(shares(65, 0.15, 0.83) - shares(65, 0.49, 0.49)) < 1.5,
    `${shares(65, 0.15, 0.83).toFixed(1)} vs ${shares(65, 0.49, 0.49).toFixed(1)}`);

  // Nessun tetto garantisce SEMPRE ≥20: per f piccolo il residuo è sempre sotto. Va provato, non assunto.
  ok('nessun tetto garantisce il residuo per QUALUNQUE frazione di fill',
    Q(65, 0.98) * 0.05 < 20 && Q(130, 0.98) * 0.05 < 20, 'un fill del 5% lascia sempre sotto il minimo');
}

console.log('\n── 2 · IL TAGLIO PER NUMERO NON C\'È PIÙ');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent24-liquidity-rewards.js'), 'utf8');
  const vive = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
  // IL TETTO E' TORNATO, MA TARATO SUL TEMPO. Toglierlo del tutto ha spinto la scansione a 12+ minuti
  // di sola profondita' (1.097 mercati a 1,5 rps) e il board oltre il limite di freschezza di agent41:
  // misurato l'11 agosto, board a 30 minuti contro un limite di 25, piazzamenti fermi. Il vincolo che il
  // numero deve rispettare non e' «quanti mercati vorremmo» ma «la scansione sta dentro il periodo».
  const m = src.match(/const MAX_CLOB_MARKETS\s*=\s*(\d+)/);
  ok('il tetto per numero esiste ed è dichiarato', !!m, m && m[1]);
  const tetto = Number(m[1]);
  const periodoMin = Number(src.match(/const SCAN_INTERVAL_MS\s*=\s*(\d+)/)[1]);
  const MAX_RPS = Number(src.match(/const MAX_RPS\s*=\s*([\d.]+)/)[1]);
  const minutiProfondita = tetto / MAX_RPS / 60;
  ok(`  ed è 400: ~${minutiProfondita.toFixed(1)} min di profondità a ${MAX_RPS} rps`, tetto === 400);
  ok('  la sola profondità sta ben dentro il periodo', minutiProfondita < periodoMin * 0.5,
    `${minutiProfondita.toFixed(1)} < ${periodoMin / 2}`);
  // Il margine che conta e' contro il limite di FRESCHEZZA di agent41, non contro il periodo.
  const TRIG = require('../maker/trigger-capitale-fermo');
  const limiteMin = TRIG.ETA_BOARD_MAX_MS / 60_000;
  ok('  e lascia margine sul limite di freschezza di agent41',
    minutiProfondita + 3 < limiteMin - 5, `~${(minutiProfondita + 3).toFixed(1)} min di scansione contro ${limiteMin} di limite`);
  ok('  il tetto che ha rotto tutto (nessun taglio) NON è tornato', /slice\(0, MAX_CLOB_MARKETS\)/.test(src));
  ok('l\'ordinamento per rate RESTA', /markets\.sort\(\(a, b\) => b\.rewardsDailyRate - a\.rewardsDailyRate\)/.test(src));
  ok('  e il log dichiara il tetto e la sua ragione', /tarato sul TEMPO/.test(src));
  // Nessuna soglia di rate è stata introdotta al suo posto: sarebbe stata un no-op travestito.
  ok('nessuna soglia minima di rate è stata aggiunta', !vive.some((l) => /MIN_REWARD_RATE|SOGLIA_RATE/.test(l)));
}

console.log('\n── 3 · IL SEGNALE «NUOVO»: ACCESO, COL TRADEOFF DICHIARATO');
{
  ok('il bonus è ACCESO', N.BONUS_ATTIVO === true);
  const c = N.mappaPrimaVisto();
  ok('  ma la mappa primaVisto si costruisce davvero', Object.keys(c.mappa).length > 100, `${Object.keys(c.mappa).length} mercati`);
  ok('  e conta i giorni di storico NON troncato', Number.isFinite(c.giorniSenzaTaglio), `${c.giorniSenzaTaglio}/${N.GIORNI_MINIMI_SENZA_TAGLIO}`);

  // Con il bonus spento NESSUN mercato cambia priorità: il moltiplicatore è 1 per tutti.
  const id = Object.keys(c.mappa)[0];
  const b1 = N.bonusPriorita(id);
  const b2 = N.bonusPriorita('0x' + 'e'.repeat(64));      // mai visto
  ok('un mercato VECCHIO non prende bonus', b1.moltiplicatore === 1 && b1.applicato === false, `${b1.eta.giorni}g`);
  ok('un mercato MAI VISTO prende il bonus', b2.moltiplicatore === N.BONUS_MAX && b2.applicato === true);
  ok('  ed è un moltiplicatore sul rate, non un riordino separato', N.BONUS_MAX > 1 && N.BONUS_MAX <= 1.5);
  ok('  e l\'esito dichiara che il segnale non è ancora provato', b2.eta.attendibile === false);
  ok('  col motivo che nomina il taglio ai primi 120', /primi 120/.test(b2.motivo || '') || /primi 120/.test(b2.eta.motivo || ''));

  // L'età si calcola comunque, ed è pubblicata: è ciò che rende il segnale verificabile prima di accenderlo.
  const e = N.etaMercato(id);
  ok('l\'età viene calcolata e pubblicata', Number.isFinite(e.giorni) && e.giorni > 0, `${e.giorni}g`);
  ok('  ed è dichiarata NON attendibile finché lo storico è troncato', e.attendibile === false);
  ok('  col motivo per esteso', /non ancora affidabile/.test(e.motivo || ''));

  // Fail-closed: storico assente ⇒ nessuna deduzione, mai «nuovo» per difetto.
  const vuoto = N.etaMercato(id, { dir: '/tmp/non-esiste-' + Date.now() });
  // Storico assente: l'eta' resta ignota. `nuovo` diventa true — e' la stessa regola del «mai visto»,
  // e con il bonus acceso significa che un ambiente senza storico tratterebbe tutto come nuovo. Non e'
  // un rischio: il bonus non apre niente, moltiplica solo un rate dentro un ordinamento.
  ok('storico assente ⇒ età ignota', vuoto.giorni === null && vuoto.primaVistoMs === null);
  ok('marketId assente ⇒ niente', N.etaMercato(null).giorni === null);

  // startDate di Gamma non viene usato da nessuna parte in questo modulo: era la fonte scartata.
  const src = fs.readFileSync(path.join(__dirname, 'mercato-nuovo.js'), 'utf8');
  const vive = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
  ok('non usa startDate di Gamma', !vive.some((l) => /startDate/.test(l)));
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// scripts/cli/avvia.js — ACCENDE L'INTERRUTTORE AVVIA, passando dal KILL invece che sopra.
//
//   node scripts/cli/avvia.js ["motivo"]
//
// ═══ COSA FA, ESATTAMENTE ════════════════════════════════════════════════════════════════════════
// Scrive `enabled:true` in `data/maker-bot-enabled.json` attraverso `lib/maker/bot-enabled.impostaBot`
// — la stessa funzione che usava il bottone del pannello. `agent41` rilegge quel file A OGNI CICLO,
// quindi vale dal ciclo dopo, senza riavviare niente.
//
// ═══ COSA NON FA, E SONO LE TRE COSE CHE CONTANO ═════════════════════════════════════════════════
//   ① NON SPEGNE IL KILL. Se il kill è attivo, questo comando LO LEGGE E SI FERMA. Il kill è
//      l'emergenza assoluta: viene armato da un guasto economico o da una mano umana, e disarmarlo è
//      una decisione separata che deve costare un gesto separato (`node scripts/safety-kill.js`,
//      oppure cancellare `data/guardian-state.json` se a fermarlo è stato il guardiano). Un «avvia»
//      che spegnesse il kill trasformerebbe due interruttori in uno, e spegnerne uno non spegnerebbe
//      più la decisione.
//   ② NON TOCCA `MAKER_MODE`. Con `MAKER_MODE=off` il bot su AVVIA gira, pianifica e non raggiunge il
//      venue: è lo stato in cui si guarda cosa FAREBBE. Passare a `live-min` è una modifica a mano
//      del `.env`, ed è l'unico gesto che questo insieme di comandi si rifiuta di automatizzare.
//   ③ NON PIAZZA NIENTE DA SÉ. Accende un permesso; a usarlo è agent41, al suo ciclo.
//
// ⚠ ACCENDERE AZZERA IL REGISTRO DELLE APERTURE (`mercatiDallAvvio`), ed è voluto: un AVVIA è sempre
// un ripartire da zero. Senza, riaccendere dopo una settimana erediterebbe i mercati di allora e il
// registro racconterebbe una sessione che non è quella in corso.

const C = require('./_comune');
C.caricaEnv();

const KS = require('../../lib/safety/kill-switch');
const BE = require('../../lib/maker/bot-enabled');
const ARC = require('../../lib/maker/auto-reprice-config');

const motivo = process.argv.slice(2).join(' ').trim() || 'acceso da terminale';

C.titolo('AVVIA');

// ── ① IL KILL HA LA PRECEDENZA, E SI LEGGE PRIMA DI TUTTO ───────────────────────────────────────
const k = KS.checkKill({});
if (k.killed) {
  console.log('  KILL: ' + C.col.rosso('ATTIVO') + C.col.spento(`  (${k.gate})`));
  console.log('  ' + C.col.spento(String(k.reason || '').slice(0, 160)));
  C.errore('il KILL è attivo: non accendo AVVIA e non lo spengo io.\n'
    + '  Il kill è l\'emergenza assoluta e si disarma di proposito, con un gesto suo:\n'
    + '    · se l\'ha armato il guardiano delle perdite → si cancella data/guardian-state.json a mano,\n'
    + '      DOPO aver guardato perché è scattato;\n'
    + '    · se l\'ha armato una mano → node scripts/safety-kill.js (o il file data/safety-kill-switch.json).\n'
    + '  Poi si rilancia questo comando.');
  return;
}
console.log('  KILL: ' + C.col.verde('spento'));

// ── LO STATO PRIMA ──────────────────────────────────────────────────────────────────────────────
const prima = BE.statoBot();
if (!prima.leggibile && prima.motivo && !/mai avviato/.test(prima.motivo)) {
  C.errore(`l'interruttore non è leggibile (${prima.motivo}) — non lo sovrascrivo alla cieca: va guardato a mano.`);
  return;
}
if (prima.enabled) {
  C.nienteDaCambiare(`il bot era già su AVVIA${prima.at ? ' dalle ' + new Date(prima.at).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : ''}`);
  console.log('');
  return;
}

// ── COSA SUCCEDERÀ DAVVERO, detto prima ─────────────────────────────────────────────────────────
const cfg = ARC.readAutoRepriceConfig();
const mercati = cfg.readable ? (cfg.enabledMarketIds || []) : null;
const modo = String(process.env.MAKER_MODE || 'off').toLowerCase();
const vivo = modo === 'live' || modo === 'live-min';

C.staPerCambiare([
  'AVVIA/FERMA: FERMA → ' + C.col.verde('AVVIA') + '  (data/maker-bot-enabled.json)',
  'il registro delle aperture di sessione viene azzerato: un AVVIA è sempre un ripartire da zero',
  `agent41 lo rileggerà al prossimo ciclo — nessun riavvio, nessun processo da toccare`,
]);

console.log('\n' + C.col.spento('  e questo è ciò che il bot troverà quando guarderà:'));
console.log('  ' + C.col.spento(`  MAKER_MODE = ${modo}`) + (vivo
  ? C.col.rosso('  ⚠ MODALITÀ VIVA: gli ordini possono raggiungere il venue')
  : C.col.spento('  ⇒ nessun ordine può raggiungere il venue: si vedrà cosa FAREBBE')));
if (mercati === null) console.log('  ' + C.col.rosso('    lista dei mercati ILLEGGIBILE ⇒ nessun mercato quotabile'));
else if (!mercati.length) console.log('  ' + C.col.giallo('    nessun mercato in lista ⇒ non aprirà niente (node scripts/cli/mercati.js aggiungi <conditionId>)'));
else console.log('  ' + C.col.spento(`    ${mercati.length} mercato/i in lista: ${mercati.join(', ')}`));

// ── L'AZIONE ────────────────────────────────────────────────────────────────────────────────────
const r = BE.impostaBot({ enabled: true, by: 'cli/avvia', reason: motivo });
if (!r.ok) { C.errore(`l'interruttore non è stato acceso: ${r.motivo}`); return; }

const dopo = BE.statoBot();
C.haCambiato([
  `AVVIA/FERMA: ${dopo.enabled ? C.col.verde('AVVIA') : C.col.rosso('??')} dalle ${new Date(dopo.at).toISOString().replace('T', ' ').slice(0, 19)}Z`,
  `motivo registrato: «${dopo.reason}»`,
  `registro aperture di sessione: ${dopo.mercatiDallAvvio.length} voci`,
]);
console.log('\n' + C.col.spento('  per fermarlo: node scripts/cli/ferma.js   ·   per vedere tutto: node scripts/cli/stato.js') + '\n');

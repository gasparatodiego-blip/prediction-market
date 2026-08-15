#!/usr/bin/env node
'use strict';
// scripts/cli/ferma.js — SPEGNE L'INTERRUTTORE AVVIA. Non è il freno d'emergenza.
//
//   node scripts/cli/ferma.js ["motivo"]
//
// ═══ LA DISTINZIONE CHE QUESTO COMANDO ESISTE PER TENERE FERMA ═══════════════════════════════════
// FERMA e KILL non sono due intensità della stessa cosa: fanno due cose diverse, e confonderle è
// pericoloso in una direzione precisa.
//
//   FERMA (questo comando)   il bot smette di APRIRE posizioni nuove. Tutto il resto continua:
//                            l'uscita automatica, la riprezzatura, i rinnovi, il completamento delle
//                            coppie. Cioè le posizioni aperte restano GESTITE, e questa è la ragione
//                            per cui è l'interruttore operativo.
//
//   KILL (`scripts/kill-maker.sh`)  emergenza assoluta. Lo leggono TUTTI i percorsi, compreso
//                            `auto-close`: killare lascia le posizioni aperte SENZA USCITA. Non è
//                            «ferma più forte», è un'altra cosa, e su capitale esposto è la più
//                            rischiosa delle due. Questo comando quindi NON lo tocca.
//
// ⚠ FERMA NON CANCELLA GLI ORDINI GIÀ A RIPOSO. Restano a libro finché non si riempiono o finché non
// scadono per GTD (~23 minuti). È voluto: un ordine maker a riposo matura reward, e toglierlo è una
// perdita certa contro un rischio incerto. Chi vuole toglierli davvero usa il kill, e ne accetta il
// prezzo — che è lasciare le posizioni senza uscita automatica.

const C = require('./_comune');
C.caricaEnv();

const KS = require('../../lib/safety/kill-switch');
const BE = require('../../lib/maker/bot-enabled');

const motivo = process.argv.slice(2).join(' ').trim() || 'fermato da terminale';

C.titolo('FERMA');

const k = KS.checkKill({});
console.log('  KILL: ' + (k.killed ? C.col.rosso('ATTIVO') + C.col.spento(`  (${k.gate}) — resta com'è: questo comando non lo tocca`) : C.col.verde('spento')));

const prima = BE.statoBot();
if (!prima.leggibile && prima.motivo && !/mai avviato/.test(prima.motivo)) {
  // ⚠ QUI SI PROCEDE LO STESSO, e la direzione è la ragione. Un interruttore illeggibile vale già
  // «fermo» per ogni lettore (`statoBot` risponde enabled:false), quindi riscriverlo a FERMA non può
  // che confermare lo stato in cui il bot si trova. È l'opposto di `avvia.js`, che su uno stato
  // illeggibile si rifiuta: là si concederebbe un permesso senza sapere da cosa si parte.
  console.log('  ' + C.col.giallo(`stato precedente illeggibile (${prima.motivo}) — si scrive FERMA lo stesso: è la direzione che non concede niente.`));
} else if (!prima.enabled) {
  C.nienteDaCambiare(`il bot era già su FERMA${prima.at ? ' dalle ' + new Date(prima.at).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : ''}`);
  console.log('');
  return;
}

C.staPerCambiare([
  'AVVIA/FERMA: ' + C.col.verde('AVVIA') + ' → ' + C.col.giallo('FERMA') + '  (data/maker-bot-enabled.json)',
  'agent41 lo rileggerà al prossimo ciclo: nessun riavvio, nessun processo da toccare',
  C.col.spento('NON vengono cancellati gli ordini a riposo: scadranno per GTD (~23 min) o si riempiranno'),
  C.col.spento('NON viene fermata l\'uscita automatica: le posizioni aperte restano gestite — è il punto di FERMA'),
  C.col.spento('il KILL resta ' + (k.killed ? 'ATTIVO' : 'spento') + ': è un altro interruttore e ha un altro comando'),
]);

const r = BE.impostaBot({ enabled: false, by: 'cli/ferma', reason: motivo });
if (!r.ok) { C.errore(`l'interruttore non è stato spento: ${r.motivo}`); return; }

const dopo = BE.statoBot();
C.haCambiato([
  `AVVIA/FERMA: ${dopo.enabled ? C.col.rosso('ANCORA AVVIA — GUARDARE SUBITO') : C.col.giallo('FERMA')} dalle ${new Date(dopo.at).toISOString().replace('T', ' ').slice(0, 19)}Z`,
  `motivo registrato: «${dopo.reason}»`,
]);
if (dopo.enabled) { C.errore('lo stato riletto dice ancora AVVIA: la scrittura non ha attecchito.'); return; }
console.log('\n' + C.col.spento('  emergenza vera (cancella gli ordini e ferma anche l\'uscita): scripts/kill-maker.sh') + '\n');

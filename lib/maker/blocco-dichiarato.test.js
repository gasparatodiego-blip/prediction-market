#!/usr/bin/env node
'use strict';
// UN PULSANTE SPENTO DEVE DIRE PERCHÉ. SEMPRE.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// Nel riepilogo compatto, «Conferma e piazza — INVIA DAVVERO» compariva spento con TUTTI gli indicatori
// verdi — non incrocia, in banda, prezzo dal piano, size sopra il minimo — e nessun motivo, da nessuna
// parte. Scorrere l'intero riquadro non serviva: non c'era niente da trovare.
//
// La causa è mia, della sessione in cui il riepilogo è nato (ef61fab). L'elenco dei gate bloccanti era
// renderizzato SOLO dentro il ramo `sheetStep === 'form'`. Finché per confermare bisognava passare dal
// modulo, quell'elenco lo si vedeva per forza. Poi ho fatto atterrare la coda DIRETTAMENTE sul
// riepilogo — il percorso si è accorciato, che era lo scopo — e il solo posto in cui i motivi erano
// scritti è rimasto fuori dal cammino. Il pulsante continuava a leggere `canReview`; i motivi no.
//
// Non è un messaggio dimenticato: è una GARANZIA COSTRUITA SU UN PERCORSO E ASSENTE SULL'ALTRO — la
// stessa classe di difetto che questo progetto ha passato settimane a togliere, reintrodotta da me
// spostando una schermata.
//
// ═══ COSA MISURA QUESTO TEST ════════════════════════════════════════════════════════════════════════
// L'invariante, non i casi: NON ESISTE uno stato in cui il pulsante è spento e l'elenco dei motivi è
// vuoto. E poi che il pannello quell'elenco lo renda davvero, invece di calcolarlo e buttarlo via —
// che è l'altro modo in cui questo difetto sa presentarsi.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const OP = leggi('app', 'components', 'OrderPanel.tsx');
const MAN = leggi('app', 'components', 'ManualOrdersPanel.tsx');
const B = require('./motivi-blocco');

console.log('\n══ 1 · L INVARIANTE, ESERCITATA');
pass += B.selfcheck();

console.log('\n══ 2 · OGNI GATE DEL PANNELLO PRODUCE UN MOTIVO VISIBILE');
{
  // Le nove chiavi che `problems` può produrre in OrderPanel. Si leggono dal SORGENTE: se qualcuno ne
  // aggiunge una decima e non le dà un rimedio, questo test lo trova.
  const codice = OP.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
  // Si cattura anche il flag `blocking`, perché la regola non è la stessa per tutti: un AVVISO non
  // spegne niente, e pretendere un rimedio per un avviso vorrebbe dire scriverne uno finto.
  const gates = [...codice.matchAll(/out\.push\(\{\s*key:\s*'([a-z-]+)'[\s\S]{0,400}?blocking:\s*(true|false)/g)]
    .map((m) => ({ key: m[1], blocking: m[2] === 'true' }));
  const bloccanti = gates.filter((g) => g.blocking).map((g) => g.key);
  const avvisi = gates.filter((g) => !g.blocking).map((g) => g.key);
  ok('i gate del pannello si contano nel sorgente', gates.length >= 9,
    `${bloccanti.length} bloccanti (${bloccanti.join(', ')}) · ${avvisi.length} avvisi (${avvisi.join(', ') || 'nessuno'})`);

  for (const k of bloccanti) {
    const r = B.motiviBlocco({ problemiBloccanti: [{ key: k, text: `gate ${k}`, blocking: true }] });
    ok(`  ${k} → pulsante spento E motivo presente`,
      r.puoInviare === false && r.motivi.length === 1 && r.motivi[0].testo === `gate ${k}`);
  }
  // Il rimedio si pretende solo da chi BLOCCA: un blocco senza rimedio è un vicolo cieco. Se domani
  // un avviso diventasse bloccante, comparirebbe qui senza rimedio e questa riga diventerebbe rossa.
  const senzaAzione = bloccanti.filter((k) => !B.AZIONI[k]);
  ok('  e ogni gate BLOCCANTE ha anche il rimedio', senzaAzione.length === 0,
    senzaAzione.join(', ') || `${bloccanti.length} su ${bloccanti.length} coperti`);

  // Gli avvisi non devono spegnere niente: un avviso che spegne è un blocco travestito.
  for (const k of avvisi) {
    ok(`  l avviso ${k} NON spegne il pulsante`,
      B.motiviBlocco({ problemiBloccanti: [{ key: k, text: 'x', blocking: false }] }).puoInviare === true);
  }
}

console.log('\n══ 3 · LE CONDIZIONI CHE SPEGNEVANO DA FUORI LA LISTA');
{
  // Erano quattro termini nella `disabled`, e solo uno aveva un messaggio in questa schermata.
  const casi = [
    ['un gate bloccante (era SILENZIOSO)', { problemiBloccanti: [{ key: 'not-live', text: 'x', blocking: true }] }],
    ['invio in corso', { busy: true }],
    ['chiamata al motore in corso', { trkBusy: true }],
    ['riepilogo incompleto', { riepilogoCompleto: false, mancanti: ['prezzo'] }],
  ];
  for (const [nome, stato] of casi) {
    const r = B.motiviBlocco(stato);
    ok(`${nome} → spento, e con un motivo`, r.puoInviare === false && r.motivi.length > 0);
  }
  const tutte = B.motiviBlocco({
    problemiBloccanti: [{ key: 'not-live', text: 'x', blocking: true }, { key: 'enable', text: 'y', blocking: true }],
    busy: true, riepilogoCompleto: false, mancanti: ['prezzo'],
  });
  ok('più cause insieme → TUTTI i motivi, non il primo', tutte.motivi.length === 4,
    `${tutte.motivi.length} motivi: ${tutte.motivi.map((m) => m.chiave).join(', ')}`);
}

console.log('\n══ 4 · IL PANNELLO USA QUELL ELENCO, E LO MOSTRA');
{
  ok('il pulsante è spento da UNA condizione sola', /disabled=\{!blocco\.puoInviare\}/.test(OP));
  ok('  e non dalla vecchia catena di quattro termini',
    !/disabled=\{busy \|\| trkBusy \|\| !canReview \|\| !riepilogo\.completo\}/.test(OP),
    'tre dei quattro non avevano un messaggio in questa schermata');
  ok('l elenco dei motivi è renderizzato NELLA schermata di conferma',
    /data-op-review-blocchi/.test(OP) && /blocco\.motivi\.map/.test(OP));
  ok('  con il rimedio accanto al motivo', /\{m\.azione \? </.test(OP));
  ok('  e ogni motivo è ancorato alla sua chiave', /data-op-review-blocco=\{m\.chiave\}/.test(OP));

  // LA REGRESSIONE ORIGINALE, NOMINATA: i motivi devono stare nel ramo del RIEPILOGO, non solo in
  // quello del modulo. Si confrontano due posizioni reali nel file, non una fetta di lunghezza inventata.
  const iRiepilogo = OP.indexOf('data-op-qs-review');
  const iBlocchi = OP.indexOf('data-op-review-blocchi');
  const iProblemiForm = OP.indexOf('data-op-qs-problems');
  ok('i motivi stanno DOPO l inizio del riepilogo, cioè dentro quel ramo',
    iRiepilogo > 0 && iBlocchi > iRiepilogo);
  ok('  e l elenco del modulo resta dov era, per chi ci passa',
    iProblemiForm > 0 && iProblemiForm < iRiepilogo);
}

console.log('\n══ 5 · IL PANNELLO MANUALE NON HA LO STESSO DIFETTO');
{
  // Verificato, non dato per scontato: lì la `disabled` ha due termini e ognuno ha il suo messaggio.
  ok('il pulsante di invio dichiara i suoi blocchi', /\{!canPlace && \(/.test(MAN));
  const ternari = (MAN.match(/killed \? 'Bloccato dal kill-switch[\s\S]{0,600}?Inserisci prezzo e size/) || [])[0] || '';
  for (const ramo of ['killed', 'manualOn', 'overCap', 'rules?.readable', 'verdict']) {
    ok(`  copre il caso ${ramo}`, ternari.includes(ramo));
  }
  ok('  e il riepilogo incompleto ha il suo riquadro', /data-manual-review-incompleto/.test(MAN));
  ok('  quindi nessun termine della sua `disabled` e silenzioso',
    /disabled=\{!canPlace \|\| !riepilogo\.completo\}/.test(MAN),
    'due termini, due messaggi');
}

console.log(`\nblocco dichiarato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

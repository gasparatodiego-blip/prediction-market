'use strict';
// lib/maker/motivi-blocco.js — SE IL PULSANTE È SPENTO, C'È SCRITTO PERCHÉ. SEMPRE.
//
// ═══ IL DIFETTO CHE HA PRODOTTO QUESTO MODULO ════════════════════════════════════════════════════════
// Nel riepilogo compatto introdotto con ef61fab, «Conferma e piazza — INVIA DAVVERO» compariva spento
// con TUTTI gli indicatori verdi: non incrocia, in banda, prezzo dal piano, size sopra il minimo. E
// nessun motivo, da nessuna parte.
//
// La causa è mia, ed è della sessione in cui il riepilogo è nato. L'elenco dei problemi bloccanti era
// renderizzato SOLO dentro il ramo `sheetStep === 'form'`. Finché per confermare bisognava passare dal
// modulo, quell'elenco lo si vedeva per forza. Poi ho fatto atterrare la coda DIRETTAMENTE sul
// riepilogo — accorciando il percorso, che era lo scopo — e il solo posto in cui i motivi erano scritti
// è rimasto fuori dal cammino. Il pulsante continuava a leggere `canReview`, i motivi no.
//
// Non è un messaggio dimenticato: è una GARANZIA COSTRUITA SU UN PERCORSO E ASSENTE SULL'ALTRO. È la
// stessa classe di difetto che questo progetto ha passato settimane a togliere — e l'ho reintrodotta
// spostando una schermata.
//
// ═══ PERCHÉ UN MODULO E NON DUE RIGHE DI JSX ═════════════════════════════════════════════════════════
// Perché «il pulsante è spento» e «i motivi sono questi» erano due espressioni diverse, in due punti
// diversi del file, che potevano divergere — e sono divergute. Qui sono UNA cosa sola:
//
//     puoInviare  ⇔  motivi.length === 0
//
// L'invariante non è commentata: è la definizione. Non esiste uno stato in cui il pulsante è spento e
// l'elenco è vuoto, perché è lo stesso elenco a spegnerlo.

/** Cosa fare, per i motivi in cui una risposta esiste. Un blocco senza rimedio è un vicolo cieco. */
const AZIONI = {
  'not-live': 'Il libro di un mercato tranquillo può restare fermo più di 30 secondi con la sottoscrizione perfettamente viva: succede, e si risolve da solo. Il pannello ricontrolla da sé — appena il book si muove il pulsante si riaccende. Non serve chiudere e riaprire.',
  enable: 'Usa «Abilita ora» qui sopra: mette il mercato nel catalogo abilitato senza uscire dal pannello.',
  kill: 'Il kill-switch si spegne dal pannello ordini manuali. Finché è attivo nessun ordine parte, da nessun percorso.',
  balance: 'Deposita altro collaterale sul proxy, oppure riduci la size.',
  cap: 'Riduci la size: il tetto per ordine è una regola di sicurezza, non un suggerimento.',
  minsize: 'Alza la size fino alla soglia premiante, oppure accetta di piazzare fuori dal programma premi — ma allora conviene saperlo prima.',
  tick: 'Usa il prezzo valido più vicino: il venue non accetta prezzi fuori dalla griglia.',
  price: 'Un prezzo si esprime fra 0 e 1 su questo venue.',
  size: 'Inserisci una size.',
  incompleto: 'Torna al modulo con «Modifica» e completa il dato mancante.',
  invio: 'Sta partendo: aspetta l\'esito invece di premere di nuovo.',
};

/**
 * TUTTI I MOTIVI PER CUI IL PULSANTE DI INVIO È SPENTO, in un elenco solo.
 *
 * @param {object} a
 *   problemiBloccanti  l'elenco già calcolato dai gate del pannello: [{key, text, blocking}]
 *   busy               un invio è in corso
 *   trkBusy            una chiamata al motore è in corso
 *   riepilogoCompleto  il riepilogo ha tutti i dati essenziali
 *   mancanti           quali dati mancano, se non è completo
 *
 * @returns {{motivi: Array<{chiave, testo, azione}>, puoInviare: boolean}}
 *          `puoInviare` è definito COME `motivi.length === 0`: non è una seconda condizione da tenere
 *          allineata, è la stessa.
 */
function motiviBlocco({
  problemiBloccanti = [], busy = false, trkBusy = false,
  riepilogoCompleto = true, mancanti = [],
} = {}) {
  const motivi = [];

  // ── I GATE DEL PANNELLO ─────────────────────────────────────────────────────────────────────────
  // Arrivano già filtrati su `blocking`, e non vengono riscritti: sono gli stessi che decidono
  // `canReview`. Qui si aggiunge solo il rimedio, dove esiste.
  for (const p of problemiBloccanti) {
    if (!p || p.blocking === false) continue;
    motivi.push({ chiave: p.key, testo: p.text, azione: AZIONI[p.key] || null });
  }

  // ── I DATI MANCANTI NEL RIEPILOGO ──────────────────────────────────────────────────────────────
  if (!riepilogoCompleto) {
    const elenco = Array.isArray(mancanti) && mancanti.length ? mancanti.join(', ') : 'un dato essenziale';
    motivi.push({
      chiave: 'incompleto',
      testo: `Manca ${elenco}: non si conferma un ordine di cui non si sa questo.`,
      azione: AZIONI.incompleto,
    });
  }

  // ── UN INVIO GIÀ IN CORSO ──────────────────────────────────────────────────────────────────────
  // Il pulsante lo dice già cambiando testo, ma se non comparisse anche qui l'invariante avrebbe
  // un'eccezione — e un'invariante con un'eccezione è una convenzione.
  if (busy || trkBusy) {
    motivi.push({
      chiave: 'invio',
      testo: busy ? 'Invio in corso.' : 'Chiamata al motore in corso.',
      azione: AZIONI.invio,
    });
  }

  return { motivi, puoInviare: motivi.length === 0 };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/maker/motivi-blocco').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  // ── L'INVARIANTE, SU TUTTO LO SPAZIO DEGLI STATI ────────────────────────────────────────────────
  // Non «questi casi funzionano»: NON ESISTE uno stato in cui si blocca senza dire perché.
  const gate = { key: 'not-live', text: 'Non si conferma su un prezzo non live', blocking: true };
  let combinazioni = 0, violazioni = 0;
  for (const problemi of [[], [gate], [gate, { key: 'enable', text: 'x', blocking: true }]]) {
    for (const busy of [true, false]) {
      for (const trkBusy of [true, false]) {
        for (const completo of [true, false]) {
          for (const mancanti of [[], ['prezzo'], ['prezzo', 'size']]) {
            const r = motiviBlocco({ problemiBloccanti: problemi, busy, trkBusy, riepilogoCompleto: completo, mancanti });
            combinazioni++;
            if (r.puoInviare === false && r.motivi.length === 0) violazioni++;
            if (r.puoInviare === true && r.motivi.length > 0) violazioni++;
            for (const m of r.motivi) if (!m.testo || !String(m.testo).trim()) violazioni++;
          }
        }
      }
    }
  }
  ok(`su ${combinazioni} stati: pulsante spento ⇒ almeno un motivo, sempre`, violazioni === 0);

  // ── I CASI, UNO PER UNO ─────────────────────────────────────────────────────────────────────────
  const libero = motiviBlocco({});
  ok('nessun problema → si può inviare', libero.puoInviare === true && libero.motivi.length === 0);

  const nonLive = motiviBlocco({ problemiBloccanti: [gate] });
  ok('un gate bloccante → spento, con il motivo', nonLive.puoInviare === false && nonLive.motivi.length === 1);
  ok('  e con il rimedio, perché questo si risolve da solo',
    /si risolve da solo/.test(nonLive.motivi[0].azione));
  ok('  il testo è quello del gate, non una riscrittura', nonLive.motivi[0].testo === gate.text);

  const incompleto = motiviBlocco({ riepilogoCompleto: false, mancanti: ['prezzo', 'size'] });
  ok('riepilogo incompleto → spento, coi dati mancanti nominati',
    incompleto.puoInviare === false && /prezzo, size/.test(incompleto.motivi[0].testo));

  const inCorso = motiviBlocco({ busy: true });
  ok('invio in corso → spento, e lo dice', inCorso.puoInviare === false && inCorso.motivi[0].chiave === 'invio');

  const due = motiviBlocco({ problemiBloccanti: [gate], riepilogoCompleto: false, mancanti: ['prezzo'] });
  ok('due cause insieme → DUE motivi, non il primo che capita', due.motivi.length === 2);

  // I problemi non bloccanti non spengono niente: un avviso che spegne è un blocco travestito.
  const avviso = motiviBlocco({ problemiBloccanti: [{ key: 'expiry', text: 'scade presto', blocking: false }] });
  ok('un avviso NON bloccante non spegne il pulsante', avviso.puoInviare === true);

  // Ogni chiave di gate che il pannello può produrre ha un rimedio scritto.
  const chiaviDelPannello = ['size', 'minsize', 'price', 'tick', 'cap', 'balance', 'kill', 'enable', 'not-live'];
  const senzaAzione = chiaviDelPannello.filter((k) => !AZIONI[k]);
  ok('ogni gate del pannello ha un rimedio dichiarato', senzaAzione.length === 0,
    senzaAzione.join(', '));

  console.log('motivi-blocco: ' + n + ' assertions passed');
  return n;
}

module.exports = { motiviBlocco, AZIONI, selfcheck };

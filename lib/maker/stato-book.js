'use strict';
// lib/maker/stato-book.js — «QUESTO PREZZO È LIVE?», UNA DOMANDA CON UNA RISPOSTA SOLA.
//
// ═══ IL DIFETTO CHE HA PRODOTTO QUESTO MODULO ════════════════════════════════════════════════════════
// Nel pannello ordine, sullo stesso mercato e nello stesso istante, comparivano due affermazioni opposte:
//
//     in testata, accanto al nome        «book non live»      (giallo)
//     nel box MID e sopra l'order book   «book live · 2 min fa»
//
// Non erano due componenti né due fonti: erano DUE REGOLE nello stesso file, applicate allo stesso
// oggetto `quote`.
//
//     testata      source === 'live-book'  E  live === true  E  età ≤ 30s      ← la regola giusta
//     etichetta    source === 'live-book'                                       ← la fonte, non lo stato
//
// L'etichetta chiamava «live» la PROVENIENZA del numero. Ma «viene dal feed di agent34» e «è fresco»
// sono due fatti diversi: il feed scrive nel suo snapshot anche i book fermi — un mercato scaduto
// compare come `live-book` con un'età di trentasei minuti. Con un'età di 2 minuti la testata diceva
// correttamente di no e l'etichetta continuava a dire di sì, perché la fonte non era cambiata.
//
// La parte peggiore non è la contraddizione visibile: è che quando le due regole CONCORDANO per caso —
// cioè quasi sempre — l'etichetta sbagliata sembra confermare quella giusta. La contraddizione era
// l'unico momento in cui il difetto si vedeva.
//
// ═══ LA REGOLA, SCRITTA UNA VOLTA ════════════════════════════════════════════════════════════════════
// «Live» è un VERDETTO, non una provenienza. Qui si calcola una volta, e da quel verdetto discendono
// tutte le scritte. La garanzia che questo modulo dà, e che il test pretende:
//
//     LA PAROLA «LIVE» NON PUÒ COMPARIRE IN NESSUNA ETICHETTA SE IL VERDETTO NON È LIVE.
//
// Quando il verdetto è no, l'etichetta dice CHI ha prodotto il numero e QUANTO È FERMO — che è
// l'informazione che serve davvero per decidere se fidarsi.

/** Un numero utilizzabile. `null`, `undefined` e `NaN` non sono numeri: non valgono zero. */
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Il nome leggibile di chi ha prodotto il prezzo. Mai la parola «live»: questa è la fonte. */
function nomeFonte(source) {
  if (source === 'live-book') return 'feed agent34';
  if (source === 'gamma') return 'Gamma';
  return source ? String(source) : 'fonte ignota';
}

/** Un'età in millisecondi, resa leggibile. Sotto il secondo e mezzo si dice «adesso»: scrivere
 *  «0s fa» su un book websocket sarebbe vero e illeggibile. */
function etaLeggibile(ms) {
  if (!fin(ms)) return 'età ignota';
  if (ms < 1500) return 'adesso';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s fa`;
  return `${Math.round(ms / 60_000)} min fa`;
}

/** La stessa età, detta come una permanenza invece che come un istante: «fermo da 2 min». */
function fermoDa(ms) {
  if (!fin(ms)) return 'da quanto non si sa';
  if (ms < 60_000) return `da ${Math.round(ms / 1000)}s`;
  return `da ${Math.round(ms / 60_000)} min`;
}

/**
 * LO STATO DEL BOOK, in un oggetto solo.
 *
 * @param {object} a
 *   source        'live-book' | 'gamma' | null — CHI ha prodotto il numero
 *   live          il flag che la fonte stessa pubblica sulla propria vitalità
 *   ageMs         età del dato in millisecondi (null = non dichiarata)
 *   freshMaxMs    la soglia oltre la quale non è più fresco (30s: la stessa di agent34)
 *   lease         'idle' | 'asking' | 'held' | 'failed' — lo stato della sottoscrizione
 *   connecting    true finché il collegamento può ancora arrivare (finestra di grazia)
 *   letto         false quando non è ancora arrivata nessuna quotazione
 *   erroreLettura true se l'ultima lettura è fallita
 *
 * @returns {{live:boolean, tono:'ok'|'warn'|'bad', badge:string, freschezza:string, fonte:string,
 *            motivo:string}}
 *   live        IL VERDETTO. Tutto il resto ne discende.
 *   badge       la scritta della testata
 *   freschezza  la scritta accanto al mid e sopra il book
 *   motivo      perché il verdetto è quello che è — va nel `title`, e nei test
 */
function statoBook({
  source = null, live = null, ageMs = null, freshMaxMs = 30_000,
  lease = 'idle', connecting = false, letto = true, erroreLettura = false,
} = {}) {
  const fonte = nomeFonte(source);

  // ── NON C'È ANCORA NIENTE DA GIUDICARE ────────────────────────────────────────────────────────
  if (!letto) {
    return {
      live: false, tono: 'warn',
      badge: lease === 'asking' ? 'collegamento…' : 'book non live',
      freschezza: erroreLettura ? 'non letto' : 'in lettura…',
      fonte: 'nessuna', motivo: 'nessuna quotazione ancora ricevuta',
    };
  }

  // ── IL VERDETTO: TRE CONDIZIONI, TUTTE NECESSARIE ──────────────────────────────────────────────
  // `source` da solo non basta — è esattamente l'errore che questo modulo esiste per impedire.
  const daFeed = source === 'live-book';
  const dichiaratoVivo = live === true;
  const fresco = fin(ageMs) && ageMs <= freshMaxMs;
  const verdetto = daFeed && dichiaratoVivo && fresco;

  if (verdetto) {
    return {
      live: true, tono: 'ok', badge: 'book live',
      freschezza: `book live · ${etaLeggibile(ageMs)}`,
      fonte, motivo: `${fonte}, dichiarato vivo, ${etaLeggibile(ageMs)}`,
    };
  }

  // ── DA QUI IN GIÙ IL VERDETTO È «NO», E NESSUNA ETICHETTA PUÒ DIRE «LIVE» ──────────────────────
  // Mentre il collegamento può ancora arrivare si dice che si sta collegando, invece di far sembrare
  // definitivo un ripiego che sta per essere sostituito. Passata la finestra, il feed quel mercato non
  // lo copre, e continuare a dire «mi sto collegando» sarebbe un'attesa che non finisce mai.
  if (connecting && !daFeed) {
    return {
      live: false, tono: 'warn', badge: 'collegamento…',
      freschezza: 'connessione al book…',
      fonte, motivo: 'sottoscrizione al book in corso',
    };
  }
  if (lease === 'failed') {
    return {
      live: false, tono: 'bad', badge: 'book NON live',
      freschezza: `${fonte} · ${etaLeggibile(ageMs)}`,
      fonte, motivo: 'sottoscrizione al book non riuscita: il prezzo è di ripiego',
    };
  }
  // Il caso che produceva la contraddizione: la fonte È il feed, ma il dato è fermo. Si nomina la
  // fonte e si dice per quanto è fermo — mai «live».
  if (daFeed && !fresco) {
    return {
      live: false, tono: 'warn', badge: 'book non live',
      freschezza: `${fonte} · fermo ${fermoDa(ageMs)}`,
      fonte,
      motivo: fin(ageMs)
        ? `il feed copre il mercato ma l'ultimo aggiornamento è di ${Math.round(ageMs / 1000)}s fa, oltre i ${Math.round(freshMaxMs / 1000)}s ammessi`
        : 'il feed non dichiara l\'età del dato: senza quella non si può affermare che sia fresco',
    };
  }
  if (daFeed && !dichiaratoVivo) {
    return {
      live: false, tono: 'warn', badge: 'book non live',
      freschezza: `${fonte} · ${etaLeggibile(ageMs)} · non dichiarato vivo`,
      fonte, motivo: 'il feed pubblica il mercato ma non lo dichiara vivo',
    };
  }
  // Fonte di ripiego (Gamma): il numero c'è, non viene dal book, e lo si dice.
  return {
    live: false, tono: 'warn', badge: 'book non live',
    freschezza: `${fonte} · ${etaLeggibile(ageMs)}`,
    fonte, motivo: `il prezzo viene da ${fonte}, non dal book del venue`,
  };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/maker/stato-book').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  // ── LA CONTRADDIZIONE ESATTA, RIPRODOTTA ────────────────────────────────────────────────────────
  // Lo stato osservato in produzione: il feed copre il mercato, si dichiara vivo, ma il dato è di due
  // minuti. La testata diceva «book non live», l'etichetta «book live · 2 min fa».
  const contraddizione = statoBook({ source: 'live-book', live: true, ageMs: 120_000, lease: 'held' });
  ok('lo stato che produceva la contraddizione → verdetto NON live', contraddizione.live === false);
  ok('  la testata dice «book non live»', contraddizione.badge === 'book non live');
  ok('  E L\'ETICHETTA NON DICE PIÙ «LIVE» — era il difetto',
    !/\blive\b/i.test(contraddizione.freschezza));
  ok('  dice invece chi è la fonte e da quanto è ferma',
    contraddizione.freschezza === 'feed agent34 · fermo da 2 min');
  ok('  e il motivo è verificabile', /oltre i 30s ammessi/.test(contraddizione.motivo));

  // ── L'INVARIANTE, SU TUTTO LO SPAZIO DEGLI STATI ────────────────────────────────────────────────
  // Non «questi casi funzionano»: NESSUNO stato può produrre la parola «live» con verdetto falso.
  let combinazioni = 0;
  for (const source of ['live-book', 'gamma', null, 'clob-rest']) {
    for (const live of [true, false, null]) {
      for (const ageMs of [0, 900, 15_000, 30_000, 30_001, 120_000, null]) {
        for (const lease of ['idle', 'asking', 'held', 'failed']) {
          for (const connecting of [true, false]) {
            for (const letto of [true, false]) {
              const s = statoBook({ source, live, ageMs, lease, connecting, letto });
              combinazioni++;
              assert.ok(typeof s.live === 'boolean', 'verdetto non booleano');
              if (!s.live) {
                assert.ok(!/\blive\b/i.test(s.freschezza),
                  `ETICHETTA BUGIARDA: verdetto no ma freschezza «${s.freschezza}» (source=${source} live=${live} age=${ageMs})`);
                assert.ok(!/^book live$/.test(s.badge),
                  `BADGE BUGIARDO: verdetto no ma badge «${s.badge}»`);
              } else {
                assert.ok(s.tono === 'ok', 'verdetto live ma tono non ok');
              }
            }
          }
        }
      }
    }
  }
  ok(`su ${combinazioni} combinazioni di stato, «live» non compare MAI con verdetto falso`, true);

  // ── LE TRE CONDIZIONI SONO TUTTE NECESSARIE ─────────────────────────────────────────────────────
  ok('feed + vivo + fresco → live', statoBook({ source: 'live-book', live: true, ageMs: 9 }).live === true);
  ok('  togli la fonte → non live', statoBook({ source: 'gamma', live: true, ageMs: 9 }).live === false);
  ok('  togli il flag di vitalità → non live', statoBook({ source: 'live-book', live: false, ageMs: 9 }).live === false);
  ok('  togli la freschezza → non live', statoBook({ source: 'live-book', live: true, ageMs: 30_001 }).live === false);
  ok('  esattamente sulla soglia è ancora live', statoBook({ source: 'live-book', live: true, ageMs: 30_000 }).live === true);
  ok('età non dichiarata NON vale zero', statoBook({ source: 'live-book', live: true, ageMs: null }).live === false);

  // ── I CASI DI CONTORNO ──────────────────────────────────────────────────────────────────────────
  ok('prima della prima quotazione non si giudica', statoBook({ letto: false }).freschezza === 'in lettura…');
  ok('  e se la lettura è fallita lo si dice', statoBook({ letto: false, erroreLettura: true }).freschezza === 'non letto');
  ok('sottoscrizione fallita → tono bad', statoBook({ source: 'gamma', ageMs: 5_000, lease: 'failed' }).tono === 'bad');
  ok('mentre ci si collega su Gamma → «connessione al book…»',
    statoBook({ source: 'gamma', ageMs: 5_000, lease: 'asking', connecting: true }).freschezza === 'connessione al book…');
  ok('un book live non viene mai coperto dal messaggio di collegamento',
    statoBook({ source: 'live-book', live: true, ageMs: 900, connecting: true }).live === true);

  console.log('stato-book: ' + n + ' assertions passed');
  return n;
}

module.exports = { statoBook, nomeFonte, etaLeggibile, fermoDa, selfcheck };

#!/usr/bin/env node
'use strict';
// IL MINI-CICLO SCEGLIEVA MERCATI CHE POI NON POTEVA TOCCARE.
//
// ═══ IL DIFETTO, COME SI È PRESENTATO ════════════════════════════════════════════════════════════════
// 8 agosto 2026, 20:56 UTC. Bot su AVVIA, kill spento, $668 liquidi, piano da $600 visibile nella tab
// «Mercati ottimizzati». L'operatore preme AVVIA, il mini-ciclo forzato parte, e il log dice:
//
//     mini-ciclo FORZATO: $377 rimessi al lavoro su 5 mercato/i (0 ordini piazzati, 5 rifiutati)
//
// Cinque mercati scelti, cinque rifiuti, zero ordini. Nell'audit, cinque volte lo stesso gate:
//
//     "outcome":"reject-manual-mode-inactive"
//     "reason":"manual mode is NOT active on 0x… — agent35 is still allowed to place and cancel here.
//               Take the market manual first; two writers on one market is exactly what that flag prevents."
//
// ═══ LA CAUSA ════════════════════════════════════════════════════════════════════════════════════════
// La fase 3 del reset (lib/maker/allocation-reset.js:302-353) prende ogni mercato del piano in gestione
// manuale e gli accende l'uscita automatica PRIMA di piazzare. Il mini-ciclo del trigger a capitale
// fermo non faceva né l'una né l'altra: non c'era una sola occorrenza di `setManual` in tutta la
// funzione. Finché sceglieva dal PIANO SALVATO il difetto era invisibile — quei mercati il reset li
// aveva già preparati — e infatti i mini-cicli che pescavano da lì piazzavano davvero
// («$72.98 rimessi al lavoro … 2 ordini piazzati, 0 rifiutati»). Dal momento in cui il piano salvato
// invecchia oltre `PIANO_FRESCO_MAX_MS` il mini-ciclo RICALCOLA, sceglie mercati NUOVI che nessuno ha
// mai preparato, e allora ogni gamba muore al gate 1 di `placeManualOrder`.
//
// ═══ COSA CAMBIA, E SOPRATTUTTO COSA NON CAMBIA ══════════════════════════════════════════════════════
// NON cambia il gate. `evaluateManualGate` non è stato toccato di una virgola, e i test 4 e 5 di questo
// file lo verificano con la funzione VERA: un mercato che nessuno ha preso in gestione viene rifiutato
// esattamente come prima, e preparare il mercato A non fa passare il mercato B. La protezione contro
// due scrittori sullo stesso libro (agent35 da una parte, questo processo dall'altra) resta intera.
//
// Cambia CHI soddisfa la precondizione del gate: prima nessuno, adesso il mini-ciclo stesso — che è la
// fonte legittima, perché è lui a introdurre il mercato nel giro. È lo stesso rapporto che il reset ha
// col gate da sempre.
//
// NESSUN ORDINE REALE: `miniCiclo` gira con la corsia di piazzamento sostituita da un registratore e
// con le due scritture di stato sostituite da spie. Nessun file vero viene toccato, nessuna rete.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const A = require(path.join(ROOT, 'agents/agent41-realloc-scheduler'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT_NUOVO = '0x' + 'a1'.repeat(32);
const MKT_APERTO = '0x' + 'b2'.repeat(32);

/** Una riga di piano sana: i valori sono quelli veri del piano dell'8 agosto, riga «Snapchat». */
function riga(id, nome, over = {}) {
  return {
    marketId: id, name: nome,
    mid: 0.158, tick: 0.001, maxSpreadCents: 4.5, computedDefaultOffsetTicks: 1,
    capital: 120, sizePerSideShares: 120.2, pairCostUsd: 1, minSizeShares: 5,
    realisticBestPerDay: 1.3, rif: { scoringMid: 0.158, bestBid: 0.157, bestAsk: 0.16 },
    ...over,
  };
}

/**
 * Esegue il mini-ciclo VERO. Sostituite solo: la corsia verso il venue, le due scritture di stato e le
 * letture che toccherebbero disco o rete. `leggiPiano` risponde «nessun piano salvato» per forzare il
 * RICALCOLO — cioè esattamente il percorso su cui il difetto viveva.
 */
async function esegui({ righe, ordini = [], setEnabled, setManual, setAutoClose, saldoUsd = 668.25 } = {}) {
  const eventi = [];       // la sequenza vera delle chiamate, per poter provare l'ORDINE
  const mandati = [];
  const r = await A.miniCiclo({ saldoUsd, forzato: true }, {
    leggiPiano: () => ({ ok: false, motivo: 'nessun piano salvato' }),
    pianoLeggero: async () => ({ rows: righe }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    etaBoardMs: 60_000,
    diag: { readable: true, openNotionalUsd: 0 },
    leggiPosizioni: () => ({ readable: true, ageMs: 0, positions: [] }),
    registraMercatoAperto: ({ marketId }) => { eventi.push(['apertura', marketId]); return { ok: true, giaPresente: false }; },
    // I TETTI DI CAPITALE RESTANO FUORI DA QUESTO TEST, e vanno iniettati o il mini-ciclo scriverebbe
    // `data/maker-allocated-capital.json` VERO a ogni esecuzione della suite (dal 9 agosto 2026 il
    // trigger li aggiorna, vedi CLAUDE.md §5 punto 53). Qui si risponde «fotografia illeggibile», che
    // e' il ramo fail-closed: si decide di non scrivere, e nessuna di queste asserzioni ne dipende.
    leggiTetti: () => ({ readable: false, error: 'non pertinente a questo test', markets: {} }),
    scriviTetti: () => { throw new Error('questo test non deve scrivere i tetti'); },
    setEnabled: setEnabled || (({ marketId, enabled }) => { eventi.push(['setEnabled', marketId, enabled]); return { ok: true }; }),
    setManual: setManual || (({ marketId, manual }) => { eventi.push(['setManual', marketId, manual]); return { ok: true }; }),
    setAutoClose: setAutoClose || (({ marketId, enabled }) => { eventi.push(['setAutoClose', marketId, enabled]); return { ok: true }; }),
    piazza: async (rows) => {
      for (const x of rows) eventi.push(['piazza', x.marketId]);
      mandati.push(...rows);
      return { ok: true, placed: rows.length, refused: 0, skipped: 0, results: rows.map((x) => ({ ...x, esito: 'TEST — non inviato' })) };
    },
  });
  return { r, eventi, mandati };
}

// ══ 1 · IL CASO DELL'8 AGOSTO, ESATTO ═════════════════════════════════════════════════════════════
(async () => {
  console.log('\n══ 1 · UN MERCATO NUOVO DAL RICALCOLO: DEVE PIAZZARE, NON FARSI RIFIUTARE');
  {
    const { r, eventi, mandati } = await esegui({ righe: [riga(MKT_NUOVO, 'Mercato mai visto')] });

    ok('il giro alloca invece di rispondere «nessuna azione»', r.esito === 'allocato', r.esito + (r.motivo ? ' — ' + r.motivo : ''));
    ok('  le gambe partono davvero', mandati.length === 2, `${mandati.length} gambe`);
    ok('  e nessun mercato resta escluso per mancata preparazione',
      Array.isArray(r.nonPreparati) && r.nonPreparati.length === 0, JSON.stringify(r.nonPreparati || []));

    // LA PRECONDIZIONE DEL GATE È STATA SODDISFATTA — è questo che chiude il difetto.
    const man = eventi.filter((e) => e[0] === 'setManual');
    ok('il mercato viene PRESO IN GESTIONE MANUALE', man.length === 1 && man[0][1] === MKT_NUOVO && man[0][2] === true,
      JSON.stringify(man));
    const acc = eventi.filter((e) => e[0] === 'setAutoClose');
    ok('e gli viene ACCESA L USCITA AUTOMATICA', acc.length === 1 && acc[0][1] === MKT_NUOVO && acc[0][2] === true,
      JSON.stringify(acc));
    // La terza: senza, il gate `live-min-market-mismatch` rifiuta comunque tutto — misurato in
    // produzione l'8 agosto, col fix a due scritture già vivo.
    const abi = eventi.filter((e) => e[0] === 'setEnabled');
    ok('e viene ABILITATO nella allowlist che la corsia manuale legge',
      abi.length === 1 && abi[0][1] === MKT_NUOVO && abi[0][2] === true, JSON.stringify(abi));
  }

  // ══ 2 · L'ORDINE CONTA: PRIMA SI PREPARA, POI SI PIAZZA ═════════════════════════════════════════
  console.log('\n══ 2 · L ORDINE NON È UN DETTAGLIO — fra preparazione e ordini non esiste un istante scoperto');
  {
    const { eventi } = await esegui({ righe: [riga(MKT_NUOVO, 'Mercato mai visto')] });
    const iAbi = eventi.findIndex((e) => e[0] === 'setEnabled');
    const iMan = eventi.findIndex((e) => e[0] === 'setManual');
    const iAcc = eventi.findIndex((e) => e[0] === 'setAutoClose');
    const iPia = eventi.findIndex((e) => e[0] === 'piazza');
    ok('l abilitazione precede il primo ordine', iAbi !== -1 && iPia !== -1 && iAbi < iPia, `abi@${iAbi} piazza@${iPia}`);
    ok('la gestione manuale è presa PRIMA del primo ordine', iMan !== -1 && iMan < iPia, `man@${iMan} piazza@${iPia}`);
    ok('l uscita automatica è accesa PRIMA del primo ordine', iAcc !== -1 && iAcc < iPia, `acc@${iAcc} piazza@${iPia}`);
    ok('  e l ordine è quello del reset: abilita, prende, accende, poi piazza',
      iAbi < iMan && iMan < iAcc && iAcc < iPia, `${iAbi}<${iMan}<${iAcc}<${iPia}`);
  }

  // ══ 3 · SOLO I NUOVI ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 3 · UN MERCATO CHE HA GIÀ ORDINI NOSTRI NON VIENE RISCRITTO A OGNI GIRO');
  {
    // $60 di nostro nozionale su MKT_APERTO ⇒ `nuovo:false` (trigger-capitale-fermo.js:358).
    // $20 a riposo e non $60: col tetto per mercato a $65 un mercato con $60 gia' dentro avrebbe solo $5
    // di spazio, sotto il minimo di $34 per un ordine sensato, e uscirebbe dal giro per un motivo che
    // NON e' quello che questo caso vuole provare. Si tara l'ingresso, non l'asserzione.
    const ordini = [{ marketId: MKT_APERTO, price: 0.5, size: 40 }];
    const { eventi, r } = await esegui({
      righe: [riga(MKT_APERTO, 'Già in gestione'), riga(MKT_NUOVO, 'Mercato mai visto')],
      ordini,
    });
    const man = eventi.filter((e) => e[0] === 'setManual').map((e) => e[1]);
    ok('il mercato già aperto NON viene ripreso in gestione', !man.includes(MKT_APERTO), JSON.stringify(man));
    ok('  mentre quello nuovo sì', man.includes(MKT_NUOVO), JSON.stringify(man));
    ok('  e il giro alloca comunque su entrambi', r.esito === 'allocato' && (r.mercati || []).length === 2,
      `${(r.mercati || []).length} mercati`);
    // Non è pedanteria: `setManualMode` riscrive il record e appende una riga di audit a OGNI chiamata,
    // e il mini-ciclo può girare ogni dieci minuti. Non è idempotente, quindi non va chiamata a vuoto.
  }

  // ══ 4 · IL FERMO DURO: SE LA PREPARAZIONE NON RIESCE, NON SI PIAZZA ════════════════════════════
  console.log('\n══ 4 · PREPARAZIONE FALLITA ⇒ QUEL MERCATO ESCE DAL GIRO (e gli altri proseguono)');
  {
    // 4a · la gestione manuale non si riesce a prendere.
    const a = await esegui({
      righe: [riga(MKT_NUOVO, 'Mercato mai visto')],
      setManual: () => ({ ok: false, error: 'file di stato non scrivibile' }),
    });
    ok('setManual fallito ⇒ nessun ordine parte', a.mandati.length === 0, `${a.mandati.length} gambe`);
    ok('  e il motivo resta a verbale, non sparisce',
      (a.r.nonPreparati || []).length === 1 && /gestione manuale non presa/.test(a.r.nonPreparati[0].motivo),
      JSON.stringify((a.r.nonPreparati || []).map((x) => x.motivo)));

    // 4b · l'uscita automatica non si accende. È un fermo duro come il primo, e per la ragione detta
    // in `preparaMercatoNuovo`: `runAutoCloseCycle` visita SOLO i mercati con l'opt-in acceso, quindi
    // piazzare qui vorrebbe dire due gambe vive e nessuno che le chiuda su un fill.
    const b = await esegui({
      righe: [riga(MKT_NUOVO, 'Mercato mai visto')],
      setAutoClose: () => ({ ok: false, error: 'config non scrivibile' }),
    });
    ok('setAutoClose fallito ⇒ nessun ordine parte', b.mandati.length === 0, `${b.mandati.length} gambe`);
    ok('  col motivo giusto: mai ordini senza via d uscita',
      (b.r.nonPreparati || []).length === 1 && /uscita automatica non accesa/.test(b.r.nonPreparati[0].motivo),
      JSON.stringify((b.r.nonPreparati || []).map((x) => x.motivo)));

    // 4c · un mercato rotto non ferma gli altri: è la stessa disciplina della riga malformata.
    const c = await esegui({
      righe: [riga(MKT_NUOVO, 'Rotto'), riga(MKT_APERTO, 'Sano')],
      setManual: ({ marketId, manual }) => (marketId === MKT_NUOVO
        ? { ok: false, error: 'file di stato non scrivibile' }
        : { ok: true, marketId, manual }),
    });
    ok('un mercato non preparabile non ferma quelli che lo sono',
      c.mandati.length === 2 && c.mandati.every((x) => x.marketId === MKT_APERTO),
      `${c.mandati.length} gambe, mercati: ${[...new Set(c.mandati.map((x) => x.marketId.slice(0, 6)))].join(',')}`);

    // 4c-bis · l abilitazione non scritta ⇒ la corsia manuale rifiuterebbe per allowlist. Fermo duro
    // come gli altri due: è il gate che ha continuato a rifiutare quando il fix ne faceva solo due.
    const ab = await esegui({
      righe: [riga(MKT_NUOVO, 'Mercato mai visto')],
      setEnabled: () => ({ ok: false, error: 'config non scrivibile' }),
    });
    ok('setEnabled fallito ⇒ nessun ordine parte', ab.mandati.length === 0, `${ab.mandati.length} gambe`);
    ok('  col motivo giusto', (ab.r.nonPreparati || []).length === 1 && /abilitazione non scritta/.test(ab.r.nonPreparati[0].motivo),
      JSON.stringify((ab.r.nonPreparati || []).map((x) => x.motivo)));

    // 4d · dipendenza non cablata ⇒ non si piazza. La classe di difetto che scripts/dipendenze-scollegate.js
    // esiste per impedire: un `setManual` assente NON deve valere «nessuno prende il mercato, procedi».
    const vero = () => ({ ok: true });
    const c0 = await A.preparaMercatoNuovo(MKT_NUOVO, undefined, vero, vero);
    ok('setEnabled non cablato ⇒ rifiuto esplicito, mai un via libera',
      c0.ok === false && /nessuna funzione setEnabled cablata/.test(c0.motivo), c0.motivo);
    const d = await A.preparaMercatoNuovo(MKT_NUOVO, vero, undefined, vero);
    ok('setManual non cablato ⇒ idem', d.ok === false && /nessuna funzione setManual cablata/.test(d.motivo), d.motivo);
    const e = await A.preparaMercatoNuovo(MKT_NUOVO, vero, vero, undefined);
    ok('setAutoClose non cablato ⇒ idem', e.ok === false && /nessuna funzione setAutoClose cablata/.test(e.motivo), e.motivo);
    // Una dipendenza che ESPLODE vale «non preparato», mai un via libera.
    const f = await A.preparaMercatoNuovo(MKT_NUOVO, vero, () => { throw new Error('guasto simulato'); }, vero);
    ok('una scrittura che esplode non autorizza niente', f.ok === false && /guasto simulato/.test(f.motivo), f.motivo);
  }

  // ══ 5 · IL GATE NON È STATO TOCCATO — con la funzione VERA ═════════════════════════════════════
  console.log('\n══ 5 · LA PROTEZIONE agent35/agent41 RESTA INTERA PER TUTTI GLI ALTRI MERCATI');
  {
    const { evaluateManualGate } = require('./manual-order');
    const { setManualMode } = require('./manual-mode');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniciclo-gate-'));
    const stateFile = path.join(dir, 'manual-mode.json');
    const auditFile = path.join(dir, 'manual-mode-audit.jsonl');
    fs.writeFileSync(stateFile, JSON.stringify({ markets: {} }));

    // Prima: nessuno ha preso niente in gestione. Il gate rifiuta — come ha fatto cinque volte l'8 agosto.
    const prima = evaluateManualGate({ marketId: MKT_NUOVO }, { stateFile });
    ok('mercato mai preso in gestione ⇒ il gate RIFIUTA, col nome di sempre',
      prima.allow === false && prima.gate === 'manual-mode-inactive', String(prima.gate));

    // La stessa scrittura che il fix esegue, con la funzione VERA su un file temporaneo.
    const w = setManualMode({ marketId: MKT_NUOVO, manual: true, by: 'test', reason: 'precondizione del gate' },
      { stateFile, auditFile });
    ok('  la preparazione scrive davvero la proprietà manuale', w.ok === true, w.error || 'ok');
    const dopo = evaluateManualGate({ marketId: MKT_NUOVO }, { stateFile });
    ok('  e ADESSO lo stesso gate permette — precondizione soddisfatta, non gate allentato',
      dopo.allow === true && dopo.gate === null, String(dopo.gate));

    // ── IL PUNTO CHE CONTA: preparare A non apre B. ─────────────────────────────────────────────
    const altro = evaluateManualGate({ marketId: MKT_APERTO }, { stateFile });
    ok('un mercato che il giro NON ha toccato resta rifiutato: agent35 ne è ancora padrone',
      altro.allow === false && altro.gate === 'manual-mode-inactive', String(altro.gate));

    // Lo stato illeggibile continua a fallire CHIUSO: non si piazza su un proprietario ignoto.
    fs.writeFileSync(stateFile, '{ questo non è json');
    const rotto = evaluateManualGate({ marketId: MKT_NUOVO }, { stateFile });
    ok('stato di proprietà illeggibile ⇒ ancora rifiuto (fail closed)',
      rotto.allow === false && rotto.gate === 'manual-mode-unreadable', String(rotto.gate));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ══ 6 · IL SORGENTE NON PUÒ TORNARE INDIETRO ═══════════════════════════════════════════════════
  console.log('\n══ 6 · LA REGRESSIONE SAREBBE SILENZIOSA — quindi è il sorgente a doverla escludere');
  {
    const src = fs.readFileSync(path.join(ROOT, 'agents/agent41-realloc-scheduler.js'), 'utf8');
    const mini = src.slice(src.indexOf('async function miniCiclo'));
    ok('il mini-ciclo prepara i mercati nuovi prima di piazzare',
      /preparaMercatoNuovo\(/.test(mini) && /s\.nuovo === true/.test(mini));
    ok('  e la preparazione è un FERMO: un fallimento fa `continue`, non un avviso',
      /nonPreparati\.push\([\s\S]{0,200}?continue;/.test(mini));

    // Il gate vive in manual-order.js e non deve essere stato riscritto da questo lavoro.
    const gate = fs.readFileSync(path.join(ROOT, 'lib/maker/manual-order.js'), 'utf8');
    ok('`evaluateManualGate` rifiuta ancora quando il mercato non è manuale',
      /if \(!m\.manual\) \{[\s\S]{0,200}gate: 'manual-mode-inactive'/.test(gate));
    ok('  e nessuna scorciatoia lo salta per «origine auto»',
      !/manual-mode-inactive[\s\S]{0,400}origine\s*===\s*'auto'/.test(gate));

    // ── IL SECONDO GATE, quello che ha continuato a rifiutare quando il fix ne faceva solo due ────
    // Non lo si esercita requirendo l'adapter: l'hook di sicurezza blocca ogni comando che lo importa,
    // anche in sola lettura (CLAUDE.md §5 punto 30). Si verifica che sia ancora al suo posto e che la
    // corsia manuale continui a chiedere live-min — che è il fatto che la prima stesura aveva sbagliato.
    const ad = fs.readFileSync(path.join(ROOT, 'lib/venues/polymarket-clob-maker/adapter.js'), 'utf8');
    ok('il gate live-min rifiuta ancora i mercati fuori dalla allowlist',
      /gate: 'live-min-market-mismatch'/.test(ad) && /if \(!allowed\.includes\(got\)\)/.test(ad));
    ok('  e una lista illeggibile vale ancora lista VUOTA, non lista aperta',
      /catch \{ return \[\]; \}/.test(ad));
    const mo = fs.readFileSync(path.join(ROOT, 'lib/maker/manual-order.js'), 'utf8');
    ok('la corsia manuale chiede live-min a prescindere da MAKER_MODE del processo',
      /createMakerAdapter\(\{\s*\n\s*mode: 'live-min'/.test(mo),
      'è il fatto che smentiva «agent41 gira in MAKER_MODE=off, quindi quel gate non lo tocca»');
  }

  console.log(`\nil mini-ciclo prende il mercato in gestione: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ESPLOSO:', e); process.exit(1); });

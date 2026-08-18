#!/usr/bin/env node
'use strict';
// scripts/cli/selezione.js — LA SELEZIONE AUTOMATICA DEI MERCATI, da terminale.
//
//   node scripts/cli/selezione.js            cosa e' acceso, chi e' dentro, chi sta uscendo
//   node scripts/cli/selezione.js prova      cosa sceglierebbe ADESSO, senza scrivere niente
//   node scripts/cli/selezione.js accendi    il bot si sceglie i mercati da solo
//   node scripts/cli/selezione.js spegni     torna alla lista scritta a mano con `mercati.js`
//
// ═══ COSA FA QUESTO COMANDO, E COSA NON FA ═══════════════════════════════════════════════════════
// Cambia UN interruttore in `data/selezione-mercati.json`. **Non sceglie i mercati e non scrive la
// allowlist**: quello lo fa agent41 al giro dopo (al piu' 2 minuti), passando da `preparaMercatoNuovo`
// e da `setAutoReprice`, cioe' dalle stesse funzioni che usa gia'. Se questo comando scrivesse la
// allowlist da se', ci sarebbero due strade verso lo stesso file e un giorno direbbero cose diverse.
//
// `prova` e' l'eccezione utile: esegue la STESSA funzione di decisione di agent41 (`decidiSelezione`,
// pura) sugli stessi dati, e stampa il risultato senza salvarlo. Serve a vedere cosa succederebbe
// PRIMA di accendere, che e' l'unica domanda che vale la pena farsi davanti a un automatismo.
//
// ⚠ NON ACCENDE IL BOT, e non basta ad aprire un ordine. Servono ancora, indipendentemente: AVVIA
// (`avvia.js`), il KILL spento, l'interruttore generale del riprezzo, e `MAKER_MODE` a mano nel `.env`.
// Questo decide SU QUALI mercati, mai SE.

const fs = require('fs');
const path = require('path');
const C = require('./_comune');

C.caricaEnv();

const SELM = require('../../lib/maker/selezione-mercati');
// R1 · il numero di mercati non e' una costante: vive nell'ambiente di agent41 e si legge da
// `/proc/<pid>/environ`, come le cinture. Stampare la costante direbbe 3 mentre il bot ne apre 1.
const QUANTI = require('../../lib/maker/quanti-mercati');
const SELS = require('../../lib/maker/selezione-stato');

/** Quanti mercati sta usando il processo VIVO. `null` se agent41 non e' vivo ⇒ si dichiara il difetto,
 *  invece di far credere che il numero stampato venga dal bot. */
function quantiVivi() {
  const v = C.flottaViva().per.get('agent41-realloc-scheduler');
  const amb = v && v.pid ? C.envDiProcesso(v.pid) : null;
  const q = QUANTI.quantiMercati(amb || {});
  return amb ? String(q.quanti) : `${q.quanti} (difetto: agent41 non vivo)`;
}
const VP = require('../../lib/safety/venue-positions-snapshot');
const ARC = require('../../lib/maker/auto-reprice-config');

const [, , comando = 'stato'] = process.argv;

const BOARD = path.join(C.ROOT, 'data', 'liquidity-rewards.json');
const QUARANTENA = path.join(C.ROOT, 'data', 'quarantena-venue.json');

/** Il board. `null` — mai `[]` — se non si legge: la differenza decide se ci si astiene o si crede
 *  che il mondo sia vuoto, ed e' la stessa distinzione che fa agent41. */
function leggiBoard() {
  try {
    const raw = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
    return Array.isArray(raw && raw.markets) ? raw.markets : null;
  } catch { return null; }
}

function leggiPosizioni() {
  const p = VP.readVenuePositions();
  if (!p || p.readable !== true) return { leggibile: false, motivo: (p && p.reason) || 'snapshot non leggibile', conditionIds: [], ageMs: p && p.ageMs };
  const ids = [];
  for (const x of (p.positions || [])) {
    const c = typeof x.conditionId === 'string' ? x.conditionId.trim().toLowerCase() : '';
    const s = Number(x.size);
    if (c && Number.isFinite(s) && s > 0 && !ids.includes(c)) ids.push(c);
  }
  return { leggibile: true, motivo: null, conditionIds: ids, ageMs: p.ageMs };
}

function leggiQuarantena() {
  try { return Object.keys(JSON.parse(fs.readFileSync(QUARANTENA, 'utf8')).mercati || {}); } catch { return []; }
}

const breve = (id) => String(id).slice(0, 12) + '…';

// ── LO STATO ────────────────────────────────────────────────────────────────────────────────────
function mostraStato(intestazione = 'SELEZIONE AUTOMATICA DEI MERCATI') {
  const s = SELS.leggiStato();
  C.titolo(intestazione);
  if (!s.leggibile) {
    console.log('  interruttore          : ' + C.col.rosso('ILLEGGIBILE ⇒ SPENTO') + C.col.spento(`  (${s.error})`));
    console.log('  ' + C.col.spento('fail-closed: un file che non si legge non puo\' autorizzare capitale su nessun mercato'));
    return s;
  }
  console.log('  interruttore          : ' + (s.attiva ? C.col.verde('ACCESA') : C.col.giallo('spenta'))
    + C.col.spento(s.attiva ? '  — agent41 sceglie i mercati a ogni ciclo' : '  — la lista si scrive a mano con `mercati.js`'));
  console.log('  vincoli               : ' + C.col.ciano(`minSize ≤ ${SELM.MIN_SIZE_MASSIMA}`)
    + ' · ' + C.col.ciano(`scadenza ≥ ${SELM.ORIZZONTE_MINIMO_ORE} h`)
    + ' · ' + C.col.ciano('niente meteo')
    + ' · ' + C.col.ciano(`max ${quantiVivi()} contemporanei`));

  const voci = Object.entries(s.stato.selezionati || {});
  const pos = leggiPosizioni();
  if (!voci.length) {
    console.log('  slot occupati         : ' + C.col.spento(`0 / ${quantiVivi()}`));
  } else {
    console.log(`  slot occupati         : ${C.col.ciano(String(voci.length))} / ${quantiVivi()}`);
    for (const [id, v] of voci) {
      const haPos = pos.leggibile && pos.conditionIds.includes(id);
      const uscente = v.uscenteDal != null;
      console.log(`    ${uscente ? C.col.giallo('◐') : C.col.verde('●')} ${breve(id)} ${String(v.question || '').slice(0, 52)}`);
      if (uscente) {
        console.log('       ' + C.col.giallo(`in USCITA da ${new Date(v.uscenteDal).toISOString().replace('T', ' ').slice(0, 19)}Z — ${v.motivoUscita}`));
        console.log('       ' + C.col.spento(haPos
          ? 'lo slot resta OCCUPATO: c\'e\' ancora una posizione aperta al venue'
          : (pos.leggibile ? 'nessuna posizione aperta: lo slot si libera al prossimo giro di agent41'
            : 'posizioni non leggibili: lo slot NON si libera su un\'ipotesi')));
      }
    }
  }
  return s;
}

// ── PROVA: la stessa decisione di agent41, senza scrivere ───────────────────────────────────────
function prova() {
  const s = SELS.leggiStato();
  const board = leggiBoard();
  const pos = leggiPosizioni();
  const quar = leggiQuarantena();

  C.titolo('PROVA — la stessa funzione di agent41, e NIENTE viene scritto');
  console.log(`  board                 : ${board ? C.col.ciano(board.length + ' righe') : C.col.rosso('NON LEGGIBILE')}`);
  console.log(`  posizioni al venue    : ${pos.leggibile ? C.col.ciano(pos.conditionIds.length + ' mercati con posizione') : C.col.rosso('NON LEGGIBILI — ' + pos.motivo)}`
    + C.col.spento(pos.leggibile ? `  · snapshot di ${C.eta(pos.ageMs)}` : ''));
  console.log(`  quarantena al venue   : ${quar.length ? C.col.giallo(quar.length + ' mercati') : C.col.spento('nessuno')}`);

  // Lo STESSO tetto d'orizzonte che aggancia agent41, letto dalla stessa fonte: se `prova` girasse
  // senza, mostrerebbe una scelta che il bot vero non farebbe.
  const orizzonteMassimoOre = (() => {
    try { return Number(require('../../lib/rewards/horizon').MAX_HORIZON_DAYS) * 24 || null; } catch { return null; }
  })();
  // ⚠ R1 · `prova` deve simulare il bot VIVO, quindi prende il numero dal suo ambiente e non dal
  // difetto: senza `max` questa prova risponderebbe per un tetto di 3 anche a operatore che ha
  // chiesto 1, cioe' mostrerebbe mercati che il bot non aprirebbe.
  const vivoQ = C.flottaViva().per.get('agent41-realloc-scheduler');
  const ambQ = vivoQ && vivoQ.pid ? C.envDiProcesso(vivoQ.pid) : null;
  const maxQ = QUANTI.quantiMercati(ambQ || {}).quanti;
  const d = SELM.decidiSelezione({ board, stato: s.stato, posizioni: pos, ora: Date.now(), escludi: quar, orizzonteMassimoOre, max: maxQ });
  if (!d.ok) {
    console.log('\n  ' + C.col.giallo('NESSUNA DECISIONE: ') + d.motivo);
    console.log('  ' + C.col.spento('e questo e\' il verso giusto: nessun mercato entra e — soprattutto — nessuno esce'));
    return;
  }
  console.log(`\n  ammissibili           : ${C.col.ciano(String(d.ammissibili))} su ${d.valutati} valutati`);
  const stampa = (etichetta, righe, colore, extra) => {
    if (!righe.length) return;
    console.log(`\n  ${colore(etichetta)}`);
    for (const r of righe) console.log(`    ${breve(r.id)} ${String(r.question || '').slice(0, 52)}${extra ? extra(r) : ''}`);
  };
  stampa('RESTANO:', d.tenuti, C.col.verde);
  stampa('ENTREREBBERO:', d.entranti, C.col.ciano, (r) => C.col.spento(`\n       minSize ${r.minSize} · ${r.oreAllaScadenza.toFixed(1)} h · stima ${r.punteggio.toFixed(3)} $/g (${r.fontePunteggio})`));
  stampa('USCIREBBERO:', d.uscenti, C.col.giallo, (r) => C.col.spento(`\n       ${r.dettaglio}`));
  stampa('SLOT LIBERATI:', d.liberati, C.col.spento);
  console.log(`\n  slot occupati dopo    : ${d.occupati} / ${quantiVivi()}`);
  if (!s.attiva) console.log('\n  ' + C.col.spento('la selezione e\' SPENTA: niente di tutto questo sta accadendo. `accendi` per attivarla.'));
}

// ── I COMANDI ───────────────────────────────────────────────────────────────────────────────────
if (comando === 'stato' || comando === 'elenca' || comando === 'ls') {
  mostraStato();
  console.log('');
  console.log(C.col.spento('  `prova` mostra cosa sceglierebbe adesso · `accendi` / `spegni` cambiano l\'interruttore'));
  console.log('');
  return;
}

if (comando === 'prova' || comando === 'simula') { prova(); console.log(''); return; }

if (comando !== 'accendi' && comando !== 'spegni') {
  C.errore(`comando «${comando}» sconosciuto. Usa: stato | prova | accendi | spegni`);
  return;
}

const vuole = comando === 'accendi';
const prima = mostraStato('PRIMA');
if (!prima.leggibile) {
  C.errore('lo stato della selezione non e\' leggibile: non si accende ne\' si spegne un automatismo sopra uno stato che non si e\' letto');
  return;
}
if (prima.attiva === vuole) {
  C.nienteDaCambiare(`la selezione automatica era gia' ${vuole ? 'ACCESA' : 'spenta'}`);
  console.log('');
  return;
}

// ── L'INTENZIONE, PRIMA DI TOCCARE ──────────────────────────────────────────────────────────────
const cfg = ARC.readAutoRepriceConfig();
const attiviOra = (cfg && cfg.readable) ? (cfg.enabledMarketIds || []) : null;
if (vuole) {
  C.staPerCambiare([
    `agent41 sceglie da solo fino a ${quantiVivi()} mercati, a ogni ciclo (≤ 2 minuti)`,
    `dentro i vincoli: minSize ≤ ${SELM.MIN_SIZE_MASSIMA} · scadenza ≥ ${SELM.ORIZZONTE_MINIMO_ORE} h · niente famiglia meteo`,
    'un mercato che esce dai vincoli viene tolto dalla lista subito, ma il suo slot si libera SOLO a posizione chiusa',
    'il piano dell\'allocatore viene ristretto ai soli mercati scelti',
    attiviOra && attiviOra.length
      ? C.col.giallo(`⚠ ${attiviOra.length} mercato/i sono gia' in lista a mano: se non rispettano i vincoli, la selezione li toglie`)
      : C.col.spento('la lista dei mercati e\' vuota adesso: la riempira\' agent41'),
    C.col.spento('NESSUN ordine viene piazzato da questo comando: servono AVVIA, il KILL spento e MAKER_MODE a mano nel .env'),
  ]);
} else {
  C.staPerCambiare([
    'agent41 smette di scegliere i mercati: la lista torna a essere quella scritta a mano con `mercati.js`',
    C.col.spento('i mercati gia' + '\'' + ' in lista RESTANO dove sono: spegnere la selezione non rilascia niente'),
    C.col.spento('il piano dell\'allocatore torna a considerare tutto il board'),
  ]);
}

const r = SELS.impostaAttiva({ attiva: vuole, by: 'cli/selezione', reason: vuole ? 'accesa da terminale' : 'spenta da terminale' });
if (!r.ok) { C.errore(`l'interruttore non e' stato scritto: ${r.error}`); return; }
C.haCambiato([`selezione automatica: ${r.prima ? 'ACCESA' : 'spenta'} → ${r.dopo ? 'ACCESA' : 'spenta'}`]);

mostraStato('DOPO');
if (vuole) {
  console.log('');
  prova();
}
console.log('');

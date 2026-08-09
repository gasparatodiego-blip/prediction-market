'use strict';
// lib/maker/ordine-orfano.js — «LA POSIZIONE CHE GIUSTIFICAVA QUEST'ORDINE ESISTE ANCORA?»
//
// ═══ IL BUCO CHE QUESTO MODULO CHIUDE ══════════════════════════════════════════════════════════════
// Una coppia nasce con due gambe a riposo: BUY YES @0,40 e BUY NO @0,60. La YES viene fillata e apre
// una posizione. Se quella posizione sparisce per una causa ESTERNA al ciclo — Diego la chiude a mano,
// o un suo ordine limite la vende — la gamba NO resta sul libro **senza più niente con cui accoppiarsi**.
//
// Fino al 9 agosto 2026 nessuno se ne accorgeva, e non per distrazione: e' STRUTTURALE.
//   · `auto-close` itera le POSIZIONI (`for (const pos of mine)`), quindi con zero posizioni il corpo
//     del ciclo non gira nemmeno una volta: niente merge, niente `decidiLivello`, nessuna riga di audit.
//     Il mercato smette semplicemente di comparire nel giornale.
//   · `auto-reprice` itera gli ORDINI, quindi la gamba orfana la vede — e la RINNOVA, tenendola viva e
//     dentro la banda premiante a ogni finestra GTD.
//   · La Regola 4 (`motore-unico`, lato singolo) dentro `[0,10 · 0,90]` dice esplicitamente «un lato solo
//     matura comunque un terzo: tenerlo e' meglio che chiuderlo», quindi la tiene apposta.
//
// Le tre difese guardavano tutte nella direzione giusta per un caso diverso. Il risultato e' un ordine
// ATTIVAMENTE mantenuto premiante che, se fillato, apre esposizione direzionale non coperta — l'opposto
// del motivo per cui era stato piazzato. L'unica cosa che lo toglieva era la scadenza GTD limitata dalla
// chiusura del MERCATO: giorni, non minuti.
//
// MISURATO IN PRODUZIONE il 9 agosto 2026: `0xd25c820d…` teneva 135,4 share, il giornale si interrompe
// di colpo alle 12:22:43 senza una riga di chiusura, e `data/merge-attese.json` portava ancora l'attesa
// aperta di quel completamento (BUY 135,4 @ 0,45 = $60,93) NOVE ORE dopo. Zero merge on-chain in tutta
// la storia del giornale e zero SELL nostre da 135,4: la posizione non e' stata ne' venduta da noi ne'
// fusa. E' sparita, e il sistema non se n'e' accorto.
//
// ═══ COSA SI CHIEDE, E PERCHE' NON SERVE DISTINGUERE LE CAUSE ══════════════════════════════════════
// La domanda non e' «perche' la posizione non c'e' piu'» ma «c'e' ancora?». Un ordine che esiste per
// accoppiarsi con una posizione che non esiste va tolto, e il motivo per cui non esiste non cambia
// l'azione. Questo evita di dover ricostruire un fill dallo storico — cosa che, misurata, NON e'
// possibile: `execution-audit.jsonl` registra solo le NOSTRE azioni (intent + esito di piazzamento,
// stati `live`/400/403) e non contiene nessun evento di fill; e nel giornale grande il `marketId` sotto
// `requested` viene oscurato dalla cintura 64-hex di `redact.js`, quindi la conta degli ordini a riposo
// non e' nemmeno attribuibile a un mercato.
//
// ═══ IL DISCRIMINANTE, E PERCHE' «UNA GAMBA SOLA» E' LA PARTE CHE CONTA ════════════════════════════
// Zero posizioni NON basta: due gambe a riposo e zero posizioni e' lo stato SANO di una coppia appena
// piazzata e mai fillata. E' l'ASIMMETRIA a dire che qualcosa e' successo:
//
//   posizioni = 0  ·  gambe a riposo = 2   ⇒  SANO      (coppia intatta, nessun fill)
//   posizioni = 0  ·  gambe a riposo = 1   ⇒  ORFANO    (l'altra e' stata fillata, e la posizione non c'e')
//   posizioni > 0                          ⇒  SANO      (c'e' cosa gestire: se ne occupa auto-close)
//
// ═══ LA CONFERMA IN DUE OSSERVAZIONI, E LA CORSA CHE UCCIDE ════════════════════════════════════════
// C'e' un istante in cui il caso sano SEMBRA orfano: la gamba gemella e' stata fillata pochi secondi fa,
// quindi non e' piu' a riposo (gambe = 1), e l'API delle posizioni non ha ancora pubblicato la posizione
// appena nata (posizioni = 0). Cancellare li' vorrebbe dire togliere la gamba superstite PROPRIO nel
// momento in cui il Lavoro B sta per gestire il fill — il falso positivo peggiore possibile.
//
// La finestra e' di pochi secondi, ma non e' zero, e non si chiude con una lettura piu' fresca: si
// chiude ASPETTANDO. Quindi la prima osservazione ARMA e basta — l'ordine viene rinnovato normalmente —
// e solo una seconda osservazione, dopo `CONFERMA_MS`, cancella. Se nel frattempo la posizione compare
// (il fill era vero), l'armamento si azzera e non succede niente.
//
// Il prezzo e' dichiarato: l'orfano vive una finestra GTD in piu' (~20 minuti). Contro «per sempre»,
// che e' il comportamento di oggi, e' un arrotondamento — e compra l'impossibilita' di cancellare una
// gamba viva. E' la stessa forma del mid stantio: un orologio che parte alla prima osservazione cieca e
// agisce solo se la cecita' persiste.
//
// ═══ FAIL-CLOSED, IN OGNI DIREZIONE ════════════════════════════════════════════════════════════════
// Ogni dato che manca vale RINNOVA, mai CANCELLA. Posizioni illeggibili, ordini illeggibili, token del
// mercato non risolti: si torna `ignoto` e il comportamento e' identico a quello di prima. Cancellare e'
// l'azione irreversibile di questo modulo, e non si prende mai su un'assenza di informazione.
//
// PURO: nessuna rete, nessun disco, nessun orologio proprio (`now` e' un parametro). Chi decide di
// cancellare e' il ciclo; qui si risponde soltanto alla domanda.

const SANO = 'sano';
const ORFANO = 'orfano';
const DA_CONFERMARE = 'da-confermare';
const IGNOTO = 'ignoto';

// Quanto deve persistere la condizione prima di agire. 60s e' sopra qualunque ritardo osservabile
// dell'API delle posizioni e ben sotto la finestra GTD (1380s), quindi la conferma cade sempre al
// rinnovo successivo e mai nello stesso.
const CONFERMA_MS = 60_000;

const fin = (x) => Number.isFinite(x);

// ── `Number(null)` VALE 0, E QUI COSTEREBBE UNA CANCELLAZIONE ──────────────────────────────────────
// Trovato dal selfcheck di questo stesso file, ed e' la TERZA volta che questa famiglia morde in questo
// stack (le prime due nel Lavoro B, §5 punto 66). I due danni erano entrambi nella direzione peggiore:
//   · `Number(armatoDa)` con `armatoDa` mai armato dava 0 ⇒ «armato dal 1970» ⇒ attesa enorme ⇒ ORFANO
//     alla PRIMA osservazione, cioe' esattamente la corsa del fill che la conferma esiste per evitare;
//   · `Number(size)` con `size: null` dava 0 ⇒ «posizione a zero» ⇒ un dato illeggibile diventava la
//     prova che la posizione non c'e'.
// Si guarda il valore GREZZO prima di convertirlo: `null`, `undefined` e stringa vuota non sono numeri.
const numero = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Le gambe NOSTRE a riposo su questo mercato, contate sui due token del mercato e basta.
 *
 * Un ordine su un token che non e' ne' YES ne' NO di questo mercato non e' una gamba di questa coppia e
 * non deve entrare nel conteggio: contarlo renderebbe «sano» un mercato orfano. Un ordine senza token
 * leggibile rende la conta INAFFIDABILE — non lo si salta come se non esistesse, perche' saltarlo
 * potrebbe far scendere la conta da 2 a 1 e trasformare un mercato sano in un falso orfano.
 *
 * @returns {{ok:boolean, gambe:number|null, motivo:string|null}}
 */
function gambeARiposo({ ordini = null, tokenId = null, tokenIdNo = null } = {}) {
  if (!Array.isArray(ordini)) {
    return { ok: false, gambe: null, motivo: 'ordini a riposo non leggibili' };
  }
  const y = tokenId == null ? '' : String(tokenId);
  const n = tokenIdNo == null ? '' : String(tokenIdNo);
  if (!y || !n) {
    return { ok: false, gambe: null, motivo: 'i due token del mercato non sono risolti: non si sa quali ordini siano gambe di questa coppia' };
  }
  let gambe = 0;
  for (const o of ordini) {
    const t = o && (o.tokenId ?? o.asset ?? o.token_id);
    if (t == null || String(t) === '') {
      return { ok: false, gambe: null, motivo: 'un ordine a riposo non porta il token: la conta delle gambe sarebbe inaffidabile' };
    }
    const s = String(t);
    if (s === y || s === n) gambe++;
  }
  return { ok: true, gambe, motivo: null };
}

/**
 * Le posizioni NOSTRE su questo mercato, contate sugli stessi due token.
 * @returns {{ok:boolean, quante:number|null, size:number|null, motivo:string|null}}
 */
function posizioniSulMercato({ posizioni = null, tokenId = null, tokenIdNo = null } = {}) {
  if (!Array.isArray(posizioni)) {
    return { ok: false, quante: null, size: null, motivo: 'posizioni non leggibili' };
  }
  const y = tokenId == null ? '' : String(tokenId);
  const n = tokenIdNo == null ? '' : String(tokenIdNo);
  if (!y || !n) {
    return { ok: false, quante: null, size: null, motivo: 'i due token del mercato non sono risolti' };
  }
  let quante = 0, size = 0;
  for (const p of posizioni) {
    const t = p && (p.tokenId ?? p.asset ?? p.token_id);
    if (t == null) continue;
    const s = String(t);
    if (s !== y && s !== n) continue;
    // Una size non leggibile su un token DI QUESTO mercato non si tratta come zero — vedi `numero`.
    const sz = numero(p.size);
    if (!fin(sz)) return { ok: false, quante: null, size: null, motivo: 'una posizione di questo mercato ha size non leggibile' };
    if (sz > 0) { quante++; size += sz; }
  }
  return { ok: true, quante, size: +size.toFixed(6), motivo: null };
}

/**
 * Il verdetto. Si chiama nel momento in cui il ciclo sta per RINNOVARE un ordine: e' l'istante in cui il
 * sistema tocca comunque quella gamba, e in cui l'alternativa al rinnovo — lasciarla scadere — e' gia'
 * sul tavolo.
 *
 * @param {object}   a
 * @param {Array}    a.ordiniARiposo   gli ordini nostri vivi su questo mercato (dal venue, non dal piano)
 * @param {Array}    a.posizioni       le posizioni nostre lette dal venue (la stessa fonte di auto-close)
 * @param {string}   a.tokenId         token YES del mercato
 * @param {string}   a.tokenIdNo       token NO del mercato
 * @param {number|null} a.armatoDa     istante della PRIMA osservazione orfana, o null se mai armato
 * @param {number}   a.now
 * @param {number}   [a.confermaMs]
 * @returns {{verdetto:'sano'|'orfano'|'da-confermare'|'ignoto', motivo:string,
 *            gambe:number|null, posizioni:number|null, armatoDa:number|null, attesaMs:number|null}}
 */
function verdettoOrfano({
  ordiniARiposo = null, posizioni = null, tokenId = null, tokenIdNo = null,
  armatoDa = null, now = Date.now(), confermaMs = CONFERMA_MS,
} = {}) {
  const base = { gambe: null, posizioni: null, armatoDa: null, attesaMs: null };

  const g = gambeARiposo({ ordini: ordiniARiposo, tokenId, tokenIdNo });
  if (!g.ok) return { ...base, verdetto: IGNOTO, motivo: g.motivo };

  const p = posizioniSulMercato({ posizioni, tokenId, tokenIdNo });
  if (!p.ok) return { ...base, verdetto: IGNOTO, motivo: p.motivo, gambe: g.gambe };

  base.gambe = g.gambe;
  base.posizioni = p.quante;

  // ── C'E' UNA POSIZIONE: NON E' AFFAR NOSTRO ────────────────────────────────────────────────────
  // Se c'e' qualcosa da gestire se ne occupa `auto-close`, che per quel mercato gira davvero. Qui si
  // DISARMA: una posizione comparsa e' la prova che l'osservazione precedente era la corsa del fill.
  if (p.quante > 0) {
    return { ...base, verdetto: SANO,
      motivo: `posizione presente (${p.quante} lato/i, ${p.size} share): l'ordine ha ancora la sua ragione` };
  }

  // ── ZERO POSIZIONI E DUE GAMBE: LA COPPIA SANA MAI FILLATA ─────────────────────────────────────
  if (g.gambe >= 2) {
    return { ...base, verdetto: SANO,
      motivo: `${g.gambe} gambe a riposo e nessun fill: e' una coppia intatta, si rinnova` };
  }

  // Nessuna gamba: non c'e' niente da cancellare, e non e' un caso di questo modulo.
  if (g.gambe === 0) {
    return { ...base, verdetto: SANO, motivo: 'nessuna gamba a riposo su questo mercato' };
  }

  // ── UNA GAMBA SOLA E ZERO POSIZIONI: L'ASIMMETRIA ──────────────────────────────────────────────
  const armato = numero(armatoDa);
  if (!fin(armato)) {
    return { ...base, verdetto: DA_CONFERMARE, armatoDa: now, attesaMs: 0,
      motivo: 'una gamba sola a riposo e nessuna posizione: puo' + '’' + ' essere un fill di pochi secondi fa non ancora pubblicato. Si rinnova e si riguarda al prossimo giro' };
  }
  const atteso = now - armato;
  if (!(atteso >= confermaMs)) {
    return { ...base, verdetto: DA_CONFERMARE, armatoDa: armato, attesaMs: atteso,
      motivo: `condizione orfana osservata da ${Math.round(atteso / 1000)}s: si conferma a ${Math.round(confermaMs / 1000)}s` };
  }
  return { ...base, verdetto: ORFANO, armatoDa: armato, attesaMs: atteso,
    motivo: `una gamba sola a riposo e ZERO posizioni su entrambi i token, confermato dopo ${Math.round(atteso / 1000)}s: la posizione con cui doveva accoppiarsi non esiste piu'` };
}

function selfcheck() {
  let pass = 0, fail = 0;
  const ok = (n, c) => { c ? pass++ : (fail++, console.log('  selfcheck FALLITO: ' + n)); };
  const Y = 'tok-yes', N = 'tok-no';
  const due = [{ tokenId: Y }, { tokenId: N }];
  const una = [{ tokenId: N }];
  const T0 = 1_000_000;

  // sano
  ok('due gambe, zero posizioni ⇒ sano',
    verdettoOrfano({ ordiniARiposo: due, posizioni: [], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === SANO);
  ok('una gamba ma posizione presente ⇒ sano',
    verdettoOrfano({ ordiniARiposo: una, posizioni: [{ tokenId: Y, size: 10 }], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === SANO);
  ok('posizione presente DISARMA anche se era armato',
    verdettoOrfano({ ordiniARiposo: una, posizioni: [{ tokenId: Y, size: 10 }], tokenId: Y, tokenIdNo: N, armatoDa: T0 - 999_999, now: T0 }).verdetto === SANO);
  ok('zero gambe ⇒ sano', verdettoOrfano({ ordiniARiposo: [], posizioni: [], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === SANO);
  ok('posizione a size 0 non conta come posizione',
    verdettoOrfano({ ordiniARiposo: una, posizioni: [{ tokenId: Y, size: 0 }], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === DA_CONFERMARE);

  // la conferma in due tempi
  const a = verdettoOrfano({ ordiniARiposo: una, posizioni: [], tokenId: Y, tokenIdNo: N, now: T0 });
  ok('prima osservazione ⇒ da-confermare, mai orfano', a.verdetto === DA_CONFERMARE && a.armatoDa === T0);
  ok('  e la prima osservazione NON cancella', a.verdetto !== ORFANO);
  const b = verdettoOrfano({ ordiniARiposo: una, posizioni: [], tokenId: Y, tokenIdNo: N, armatoDa: T0, now: T0 + 59_000 });
  ok('a 59s ancora da-confermare', b.verdetto === DA_CONFERMARE);
  const c = verdettoOrfano({ ordiniARiposo: una, posizioni: [], tokenId: Y, tokenIdNo: N, armatoDa: T0, now: T0 + 60_000 });
  ok('a 60s esatti ⇒ ORFANO (confine inclusivo)', c.verdetto === ORFANO);
  ok('  e porta i numeri che l\'hanno prodotto', c.gambe === 1 && c.posizioni === 0);

  // fail-closed
  ok('ordini non leggibili ⇒ ignoto',
    verdettoOrfano({ ordiniARiposo: null, posizioni: [], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === IGNOTO);
  ok('posizioni non leggibili ⇒ ignoto',
    verdettoOrfano({ ordiniARiposo: una, posizioni: null, tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === IGNOTO);
  ok('token non risolti ⇒ ignoto',
    verdettoOrfano({ ordiniARiposo: una, posizioni: [], tokenId: null, tokenIdNo: N, now: T0 }).verdetto === IGNOTO);
  ok('un ordine senza token ⇒ ignoto, NON una gamba in meno',
    verdettoOrfano({ ordiniARiposo: [{ tokenId: Y }, { foo: 1 }], posizioni: [], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === IGNOTO);
  ok('una posizione con size non finita ⇒ ignoto (Number(null) non vale zero)',
    verdettoOrfano({ ordiniARiposo: una, posizioni: [{ tokenId: Y, size: null }], tokenId: Y, tokenIdNo: N, now: T0 }).verdetto === IGNOTO);
  ok('un ordine su un token ESTRANEO non conta come gamba',
    verdettoOrfano({ ordiniARiposo: [{ tokenId: N }, { tokenId: 'altro-mercato' }], posizioni: [], tokenId: Y, tokenIdNo: N, armatoDa: T0, now: T0 + 60_000 }).verdetto === ORFANO);
  ok('  e una posizione su token estraneo non salva l\'orfano',
    verdettoOrfano({ ordiniARiposo: una, posizioni: [{ tokenId: 'altro', size: 99 }], tokenId: Y, tokenIdNo: N, armatoDa: T0, now: T0 + 60_000 }).verdetto === ORFANO);

  console.log(`ordine-orfano selfcheck: ${pass} passati, ${fail} falliti`);
  return { pass, fail };
}

module.exports = {
  SANO, ORFANO, DA_CONFERMARE, IGNOTO, CONFERMA_MS,
  gambeARiposo, posizioniSulMercato, verdettoOrfano, selfcheck,
};

if (require.main === module) { const r = selfcheck(); process.exit(r.fail ? 1 : 0); }

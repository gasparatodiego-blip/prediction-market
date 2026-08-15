'use strict';
// lib/maker/risposta-al-fill.js — COME SI RISPONDE A UN FILL: parziale o completo, e cosa si piazza.
//
// ═══ COSA AGGIUNGE, E COSA NON TOCCA ═════════════════════════════════════════════════════════════════
// Non tocca il posizionamento, il prezzo medio, il controllo del mid vivo, il tetto della coppia
// (`chiusura-rapida.TETTO_COPPIA_CENTS`, 120¢ dal 12 agosto 2026) né i livelli 1/2 del merge (`strategia-merge.decidiLivello`).
// Quelli restano dove sono e come sono. Questo modulo risponde a due domande che il codice fino al
// 9 agosto 2026 non si poneva esplicitamente:
//
//   1 · il fill è stato PARZIALE o COMPLETO?  — oggi la differenza esisteva nei numeri e in nessun ramo
//   2 · e se resta un rimasuglio sotto il minimo del venue, cosa si piazza?  — oggi: niente
//
// ═══ (a) LA DISTINZIONE, MISURATA E NON ASSUNTA ══════════════════════════════════════════════════════
// Gli unici due numeri che il venue ci dà su questo sono già in `liv.numeri`: `sizePosseduta` (quanto
// abbiamo di questo lato) e `sizeAltroLato` (quanto abbiamo dell'altro). Da lì:
//
//     manca = sizePosseduta − sizeAltroLato
//
//   · `manca <= 0`                        ⇒ COPPIA COMPLETA — non è un fill scoperto, si fonde
//   · `sizeAltroLato === 0`               ⇒ **FILL COMPLETO**: la gamba è stata eseguita per intero e
//                                            dall'altra parte non c'è niente. `manca === sizePosseduta`
//   · `0 < sizeAltroLato < sizePosseduta` ⇒ **FILL PARZIALE**: una copertura c'è ma non basta — è il
//                                            caso tipico dopo un merge parziale o un'esecuzione a metà
//
// NON si indovina niente: se uno dei due numeri non è leggibile la risposta è `ignoto`, e `ignoto` non
// fa scattare nessuno dei due rami. È la stessa regola di `horizonVerdict` su una scadenza illeggibile.
//
// ═══ (b) L'ORDINE «RIMANENZA», E UN LIMITE CHE VA DETTO PRIMA ════════════════════════════════════════
// Quando il rimasuglio scende sotto `minSize` il Livello 2 non può comprarlo (comprerebbe meno del
// minimo del venue) e fino a oggi il residuo finiva SOLO nel registro `accumulo-residui`. Adesso si
// piazza anche un ordine per la size residua, dentro la banda premiante.
//
// ⚠ IL LIMITE, DICHIARATO: su questo venue `BELOW_MIN_SIZE` è **bloccante** (`splitVerdict` declassa ad
// avviso soltanto `OUT_OF_BAND`). Un ordine di `manca` share con `manca < minSize` verrà quindi
// RIFIUTATO dal gate — ed è corretto che lo sia: un ordine sotto il minimo immobilizza capitale per un
// premio che vale zero. Il guadagno di questo passo non è quindi «l'ordine passa»: è che il tentativo
// diventa **visibile e a verbale** invece di essere silenzio, e che il registro continua ad accumulare
// finché la quantità non raggiunge il minimo — a quel punto lo stesso ordine passa da solo, senza un
// percorso speciale. Non si arrotonda MAI la size al minimo: comprerebbe più di quanto serve e
// cambierebbe l'esposizione invece di chiuderla.
//
// ═══ (c) LA SECONDA — E ULTIMA — ECCEZIONE A «MAI PRIMI SUL LIBRO» ═══════════════════════════════════
// «Mai primi sul libro» è `spec.inCoda`, ed è **opt-in per chiamante** (`manual-order.js:879`): vale solo
// per chi la dichiara. Le eccezioni sono quindi OMISSIONI puntuali di un flag su UNA gamba, mai una
// modifica alla regola — che non è stata toccata di una riga e continua a valere ovunque.
//
// Le eccezioni sono DUE, e sono due casi distinti che non vanno confusi:
//
//   1 · `chiusura-rapida.primoAssoluto` (9 agosto, §5 punto 59) — il lato posseduto è muto perché la
//       banda premiante è scesa SOTTO il prezzo di carico, e la controparte è l'unica cosa che può
//       chiudere la posizione.
//   2 · **QUESTA** — c'è un rimasuglio sotto il minimo, e la gamba contraria serve a farlo sparire in
//       fretta con un merge invece di lasciarlo lì. Lo scopo dichiarato NON è guadagnare premi su
//       quell'ordine: è chiudere. Per questo può stare in cima alla coda.
//
// Fuori da questi due casi `inCoda: true` resta su ogni gamba, compreso l'ordine «rimanenza» qui
// accanto — che è un ordine che ASPETTA, quindi la regola gli si applica per intero.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** I tre esiti della classificazione. `ignoto` non fa scattare niente. */
const FILL_COMPLETO = 'fill-completo';
const FILL_PARZIALE = 'fill-parziale';
const COPPIA_COMPLETA = 'coppia-completa';
const IGNOTO = 'ignoto';

/**
 * (a) · PARZIALE O COMPLETO?
 *
 * @param {object} a  numeri: sizePosseduta, sizeAltroLato (di norma `liv.numeri`)
 * @returns {{tipo:string, manca:number|null, sizePosseduta:number|null, sizeAltroLato:number|null, motivo:string}}
 */
function classificaFill({ sizePosseduta = null, sizeAltroLato = null } = {}) {
  // ── `Number()` QUI SAREBBE UN DIFETTO, E IL SELFCHECK L'HA TROVATO ─────────────────────────────
  // `Number(null)` vale 0. Con la coercizione un `sizeAltroLato` NON LETTO sarebbe diventato «zero
  // copertura», cioè esattamente un FILL COMPLETO — un ramo che apre ordini, dedotto da un dato che
  // non c'era. «Non lo so» e «non ce n'è» devono restare due cose diverse, ed è la regola cardinale di
  // questo repo. Si guarda quindi il valore GREZZO: solo un numero finito è un numero.
  const p = fin(sizePosseduta) ? sizePosseduta : NaN;
  const a = fin(sizeAltroLato) ? sizeAltroLato : NaN;
  if (!fin(p) || p <= 0) {
    return { tipo: IGNOTO, manca: null, sizePosseduta: null, sizeAltroLato: null,
      motivo: 'size posseduta non leggibile: non si conclude né parziale né completo' };
  }
  if (!fin(a) || a < 0) {
    return { tipo: IGNOTO, manca: null, sizePosseduta: p, sizeAltroLato: null,
      motivo: 'size dell\'altro lato non leggibile: non si conclude né parziale né completo' };
  }
  const manca = +(p - a).toFixed(6);
  if (manca <= 0) {
    return { tipo: COPPIA_COMPLETA, manca, sizePosseduta: p, sizeAltroLato: a,
      motivo: `YES e NO sono in parti uguali (${p} contro ${a}): non c'è un fill scoperto, c'è una coppia da fondere` };
  }
  if (a === 0) {
    return { tipo: FILL_COMPLETO, manca, sizePosseduta: p, sizeAltroLato: 0,
      motivo: `fill COMPLETO: ${p} share eseguite e nessuna copertura sull'altro lato` };
  }
  return { tipo: FILL_PARZIALE, manca, sizePosseduta: p, sizeAltroLato: a,
    motivo: `fill PARZIALE: ${p} share possedute contro ${a} coperte — restano ${manca} scoperte` };
}

/** Vero quando il rimasuglio è troppo piccolo perché il completamento ordinario possa comprarlo. */
function sottoIlMinimo(manca, minSize) {
  return fin(manca) && manca > 0 && fin(minSize) && minSize > 0 && manca < minSize;
}

/**
 * (b)+(c) · IL PIANO DEL RIMASUGLIO: l'ordine «rimanenza» e la gamba contraria aggressiva.
 *
 * PURO: non piazza, non legge, non scrive. Restituisce due gambe che il chiamante darà ai gate di
 * sempre — banda, fine scala, tetto per mercato, kill. Qui si propone; là si giudica.
 *
 * @param {object} a
 *   manca            la quantità scoperta (share)
 *   minSize          il minimo del venue PER QUESTO MERCATO
 *   book             il lato posseduto ('yes'|'no')
 *   prezzoRimanenza  dove appoggiare l'ordine «rimanenza» (in banda) — dal chiamante, non inventato qui
 *   bidsControparte  la scala bid dell'altro libro, per stare un tick sopra il migliore
 *   asksControparte  la scala ask dell'altro libro, per NON attraversare lo spread
 *   tick             il tick del mercato
 *   massimoControparte  il tetto di prezzo per la controparte (di norma il tetto della coppia)
 * @returns {{ok:boolean, motivo:string, rimanenza:object|null, controparte:object|null}}
 */
function pianificaRimasuglio({
  manca = null, minSize = null, book = null, prezzoRimanenza = null,
  bidsControparte = null, asksControparte = null, tick = null, massimoControparte = null,
} = {}) {
  const no = (motivo) => ({ ok: false, motivo, rimanenza: null, controparte: null });
  if (!fin(manca) || manca <= 0) return no('nessuna quantità scoperta da gestire');
  if (!fin(tick) || tick <= 0) return no('tick non leggibile: nessun prezzo viene indovinato');
  if (book !== 'yes' && book !== 'no') return no('lato posseduto non indicato');
  if (!sottoIlMinimo(manca, minSize)) {
    // Sopra il minimo il completamento ORDINARIO (Livello 2) sa già comprarlo: questo percorso non
    // deve esistere in parallelo a quello, o sarebbero due politiche per la stessa domanda.
    return no(`il rimasuglio (${manca}) non è sotto il minimo del venue (${minSize}): lo gestisce il completamento ordinario`);
  }
  const altro = book === 'yes' ? 'no' : 'yes';
  const giu = (x) => +(Math.floor((x + 1e-9) / tick) * tick).toFixed(6);
  const su = (x) => +(Math.ceil((x - 1e-9) / tick) * tick).toFixed(6);

  // ── L'ORDINE «RIMANENZA» ────────────────────────────────────────────────────────────────────────
  // Aspetta dentro la banda, quindi «mai primi sul libro» gli si applica per intero: nessuna esenzione.
  const rimanenza = fin(prezzoRimanenza) && prezzoRimanenza > 0 && prezzoRimanenza < 1
    ? { book, side: 'SELL', prezzo: giu(prezzoRimanenza), size: manca, inCoda: true, primoAssoluto: false }
    : null;

  // ── LA GAMBA CONTRARIA, AGGRESSIVA ─────────────────────────────────────────────────────────────
  // Stessa size del rimasuglio, in cima alla coda. Il prezzo è il PIÙ BASSO fra tre limiti, ognuno per
  // una ragione diversa — la stessa algebra di `chiusura-rapida`, che qui viene riusata e non riscritta:
  //   · bestBid + tick  scavalca la coda, ed è lo scopo dell'eccezione
  //   · bestAsk − tick  non attraversa lo spread: resta un limit che aspetta, non un taker
  //   · massimo         il tetto (di norma quello della coppia), che resta DURO
  const bid = Array.isArray(bidsControparte)
    ? bidsControparte.map((l) => Number(l && l.price)).filter((x) => fin(x) && x > 0).sort((a2, b2) => b2 - a2)[0] : null;
  const ask = Array.isArray(asksControparte)
    ? asksControparte.map((l) => Number(l && l.price)).filter((x) => fin(x) && x > 0).sort((a2, b2) => a2 - b2)[0] : null;
  let controparte = null;
  if (fin(bid) && bid > 0) {
    const limiti = [giu(bid + tick)];
    if (fin(ask) && ask > 0) limiti.push(giu(ask - tick));
    if (fin(massimoControparte) && massimoControparte > 0) limiti.push(giu(massimoControparte));
    const prezzo = Math.min.apply(null, limiti);
    if (prezzo > 0 && prezzo < 1) {
      controparte = { book: altro, side: 'BUY', prezzo: +prezzo.toFixed(6), size: manca,
        inCoda: false, primoAssoluto: true, limiti: { bid, ask, massimo: massimoControparte ?? null } };
    }
  }
  void su;

  if (!rimanenza && !controparte) return no('né la rimanenza né la controparte sono prezzabili con i dati letti');
  return {
    ok: true,
    motivo: `rimasuglio di ${manca} share sotto il minimo del venue (${minSize}): si piazza la rimanenza in banda`
      + (controparte ? ' e la gamba contraria in cima alla coda per chiudere in fretta' : ' (controparte non prezzabile)'),
    rimanenza, controparte,
  };
}

/**
 * (d) · LA SIZE DEL RIPOSIZIONAMENTO, COL RIPIEGO.
 *
 * ═══ LA DECISIONE, E PERCHÉ NON È IL PIANO SALVATO ═════════════════════════════════════════════════
 * La fonte è il TETTO ATTUALE IN VIGORE (`data/maker-allocated-capital.json`, oggi $130 fissi), non il
 * valore congelato in `realloc-ultimo-piano.json`. Il piano salvato può avere ore, ed è stato deciso
 * contro un capitale e un board che possono non esistere più; il tetto è invece la regola che vale
 * ADESSO ed è la stessa che i gate applicheranno all'ordine un istante dopo.
 *
 * ═══ IL RIPIEGO, ESPLICITO ═════════════════════════════════════════════════════════════════════════
 * Se il capitale libero in questo momento è meno del tetto, NON ci si ferma e non si salta: si usa
 * quello che c'è. `size = min(tetto, capitaleLibero)`. Bloccarsi per un centesimo mancante lascerebbe
 * fermo capitale che il mercato può assorbire — l'errore opposto a quello che il tetto esiste per
 * impedire.
 *
 * Se ciò che resta è sotto il minimo del venue non si forza un ordine troppo piccolo: si risponde
 * `accumula`, e il chiamante lascia la parola al registro dei residui, che è il meccanismo che quel
 * caso ha già.
 *
 * @returns {{ok:boolean, azione:'riposiziona'|'accumula'|'niente', capitaleUsd:number|null, motivo:string}}
 */
function capitalePerRiposizionamento({
  tettoUsd = null, capitaleLiberoUsd = null, minSize = null, prezzoRif = null,
} = {}) {
  const tetto = Number(tettoUsd);
  if (!fin(tetto) || tetto <= 0) {
    return { ok: false, azione: 'niente', capitaleUsd: null,
      motivo: 'tetto per mercato non leggibile: senza il limite in vigore non si riposiziona' };
  }
  // ── ANCORA `Number()`, ANCORA LO STESSO DIFETTO — trovato dal selfcheck ───────────────────────
  // `Number(null)` vale 0, quindi un capitale libero NON LETTO sarebbe diventato «zero capitale».
  // Si guarda il valore grezzo.
  //
  // E la scelta su cosa fare quando manca è FAIL-CLOSED, allineata alla dottrina che
  // `riposizionaDopoChiusura` dichiara già nella sua intestazione: «un dato mancante vale non
  // riposizionare, mai prova lo stesso». La prima stesura usava il tetto contando sul gate a valle;
  // è più prudente non piazzare — dopo un fill gestito il capitale è al sicuro, e lasciarlo liquido
  // un giro non costa niente.
  const libero = fin(capitaleLiberoUsd) ? capitaleLiberoUsd : null;
  if (libero == null) {
    return { ok: false, azione: 'niente', capitaleUsd: null,
      motivo: 'capitale libero non leggibile adesso: non si riposiziona al buio — il capitale resta liquido e la decisione torna al ciclo normale' };
  }
  const usabile = Math.min(tetto, Math.max(0, libero));
  if (!(usabile > 0)) {
    return { ok: false, azione: 'accumula', capitaleUsd: 0,
      motivo: 'nessun capitale libero adesso: non si riposiziona e non si forza niente' };
  }
  // La size per lato è metà del capitale (le due gambe si aprono insieme), e va confrontata col minimo.
  if (fin(minSize) && minSize > 0 && fin(prezzoRif) && prezzoRif > 0) {
    const sharePerLato = (usabile / 2) / prezzoRif;
    if (sharePerLato < minSize) {
      return { ok: false, azione: 'accumula', capitaleUsd: +usabile.toFixed(2),
        motivo: `con $${usabile.toFixed(2)} le gambe sarebbero di ${sharePerLato.toFixed(2)} share, sotto il minimo del venue (${minSize}):`
          + ' si lascia al registro dei residui invece di forzare un ordine troppo piccolo' };
    }
  }
  return {
    ok: true, azione: 'riposiziona', capitaleUsd: +usabile.toFixed(2),
    motivo: usabile < tetto
      ? `il tetto è $${tetto.toFixed(2)} ma il capitale libero adesso è $${libero.toFixed(2)}: si riposiziona su quello che c'è`
      : `si riposiziona al tetto pieno ($${tetto.toFixed(2)})`,
  };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/maker/risposta-al-fill').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond, extra) => { assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); n++; };

  console.log('\n(a) · PARZIALE O COMPLETO');
  ok('nessuna copertura ⇒ fill COMPLETO',
    classificaFill({ sizePosseduta: 40, sizeAltroLato: 0 }).tipo === FILL_COMPLETO);
  ok('  e manca = tutto il posseduto', classificaFill({ sizePosseduta: 40, sizeAltroLato: 0 }).manca === 40);
  ok('copertura parziale ⇒ fill PARZIALE',
    classificaFill({ sizePosseduta: 39.7, sizeAltroLato: 36.3 }).tipo === FILL_PARZIALE);
  ok('  e manca è il residuo, non il totale',
    Math.abs(classificaFill({ sizePosseduta: 39.7, sizeAltroLato: 36.3 }).manca - 3.4) < 1e-6);
  ok('parti uguali ⇒ coppia completa, non un fill scoperto',
    classificaFill({ sizePosseduta: 36.3, sizeAltroLato: 36.3 }).tipo === COPPIA_COMPLETA);
  ok('altro lato PIÙ grande ⇒ ancora coppia completa (manca <= 0)',
    classificaFill({ sizePosseduta: 20, sizeAltroLato: 25 }).tipo === COPPIA_COMPLETA);
  ok('numeri illeggibili ⇒ ignoto, MAI un ramo',
    classificaFill({ sizePosseduta: null, sizeAltroLato: 0 }).tipo === IGNOTO
    && classificaFill({ sizePosseduta: 40, sizeAltroLato: null }).tipo === IGNOTO
    && classificaFill({ sizePosseduta: 40, sizeAltroLato: NaN }).tipo === IGNOTO
    && classificaFill({}).tipo === IGNOTO);
  ok('  e una stringa non passa per un numero',
    classificaFill({ sizePosseduta: '40', sizeAltroLato: 0 }).tipo === IGNOTO);

  console.log('\n(b)+(c) · IL RIMASUGLIO');
  const bids = [{ price: 0.30 }, { price: 0.29 }];
  const asks = [{ price: 0.34 }, { price: 0.36 }];
  const p = pianificaRimasuglio({ manca: 3.4, minSize: 20, book: 'no', prezzoRimanenza: 0.54,
    bidsControparte: bids, asksControparte: asks, tick: 0.01, massimoControparte: 0.57 });
  ok('rimasuglio sotto il minimo ⇒ piano proposto', p.ok === true, p.motivo);
  ok('  la RIMANENZA è sul lato posseduto, in vendita, e dichiara inCoda',
    p.rimanenza.book === 'no' && p.rimanenza.side === 'SELL' && p.rimanenza.inCoda === true
    && p.rimanenza.primoAssoluto === false);
  ok('  la CONTROPARTE è sull\'altro lato, in acquisto, stessa size',
    p.controparte.book === 'yes' && p.controparte.side === 'BUY' && p.controparte.size === 3.4);
  ok('  ed è l\'UNICA delle due a essere primo assoluto',
    p.controparte.primoAssoluto === true && p.controparte.inCoda === false);
  ok('  prezzo della controparte = bestBid + 1 tick (scavalca la coda)', p.controparte.prezzo === 0.31,
    String(p.controparte.prezzo));
  const stretto = pianificaRimasuglio({ manca: 3.4, minSize: 20, book: 'no', prezzoRimanenza: 0.54,
    bidsControparte: [{ price: 0.33 }], asksControparte: [{ price: 0.34 }], tick: 0.01, massimoControparte: 0.57 });
  ok('  non attraversa MAI lo spread: si ferma a bestAsk − 1 tick', stretto.controparte.prezzo === 0.33,
    String(stretto.controparte.prezzo));
  const capato = pianificaRimasuglio({ manca: 3.4, minSize: 20, book: 'no', prezzoRimanenza: 0.54,
    bidsControparte: [{ price: 0.30 }], asksControparte: [{ price: 0.90 }], tick: 0.01, massimoControparte: 0.25 });
  ok('  e il tetto resta DURO: vince se è il più basso dei tre', capato.controparte.prezzo === 0.25,
    String(capato.controparte.prezzo));
  ok('rimasuglio SOPRA il minimo ⇒ non è affare di questo percorso',
    pianificaRimasuglio({ manca: 25, minSize: 20, book: 'no', prezzoRimanenza: 0.5, tick: 0.01 }).ok === false);
  ok('tick illeggibile ⇒ niente, nessun prezzo indovinato',
    pianificaRimasuglio({ manca: 3.4, minSize: 20, book: 'no', prezzoRimanenza: 0.5, tick: null }).ok === false);
  ok('senza la scala bid la controparte non si propone, ma la rimanenza sì', (() => {
    const x = pianificaRimasuglio({ manca: 3.4, minSize: 20, book: 'no', prezzoRimanenza: 0.54, tick: 0.01 });
    return x.ok === true && x.controparte === null && x.rimanenza !== null;
  })());
  ok('la size NON viene mai arrotondata al minimo del venue',
    p.rimanenza.size === 3.4 && p.controparte.size === 3.4);

  console.log('\n(d) · IL CAPITALE DEL RIPOSIZIONAMENTO');
  const pieno = capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 500, minSize: 20, prezzoRif: 0.5 });
  ok('capitale abbondante ⇒ tetto pieno $130', pieno.ok === true && pieno.capitaleUsd === 130, pieno.motivo);
  const ridotto = capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 80, minSize: 20, prezzoRif: 0.5 });
  ok('capitale ridotto ⇒ si usa QUELLO CHE C\'È, non ci si blocca',
    ridotto.ok === true && ridotto.azione === 'riposiziona' && ridotto.capitaleUsd === 80, ridotto.motivo);
  ok('  e il motivo dice che il tetto non è stato raggiunto', /capitale libero adesso/.test(ridotto.motivo));
  const quasi = capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 129.99, minSize: 20, prezzoRif: 0.5 });
  ok('manca un centesimo ⇒ si riposiziona lo stesso su 129,99', quasi.ok === true && quasi.capitaleUsd === 129.99);
  const briciola = capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 4, minSize: 20, prezzoRif: 0.5 });
  ok('sotto il minimo del venue ⇒ accumula, non forza un ordine piccolo',
    briciola.ok === false && briciola.azione === 'accumula', briciola.motivo);
  ok('capitale libero ILLEGGIBILE ⇒ non si riposiziona al buio (fail-closed, come riposizionaDopoChiusura)',
    capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: null, minSize: 20, prezzoRif: 0.5 }).azione === 'niente');
  ok('  e un `null` NON viene contato come zero capitale',
    capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: null }).azione
      !== capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 0 }).azione);
  ok('tetto illeggibile ⇒ non si riposiziona (fail-closed)',
    capitalePerRiposizionamento({ tettoUsd: null, capitaleLiberoUsd: 500 }).azione === 'niente');
  ok('capitale libero ZERO ⇒ accumula, non un ordine da $0',
    capitalePerRiposizionamento({ tettoUsd: 130, capitaleLiberoUsd: 0 }).azione === 'accumula');

  console.log('\nrisposta-al-fill: ' + n + ' assertions passed\n');
  return n;
}

module.exports = {
  FILL_COMPLETO, FILL_PARZIALE, COPPIA_COMPLETA, IGNOTO,
  classificaFill, sottoIlMinimo, pianificaRimasuglio, capitalePerRiposizionamento, selfcheck,
};

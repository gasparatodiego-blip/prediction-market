'use strict';
// lib/maker/riepilogo-ordine.js — CIÒ CHE SI LEGGE PRIMA DI TOCCARE «CONFERMA», E NIENT'ALTRO.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Il percorso obbligato per piazzare era: pannello lungo → blocco dati di mercato → order book intero →
// nota d'uso → nota sul mid → tocca una riga del book → form → riepilogo → conferma. Su un telefono
// sono parecchie schermate di scorrimento prima di arrivare al punto, e con due gambe si ripete due
// volte. Un percorso lungo non rende una decisione più consapevole: la rende più stanca, e la parte che
// conta — prezzo, size, incrocia?, in banda? — arriva quando l'attenzione è già stata spesa altrove.
//
// Qui vive la SOSTANZA di quella schermata: quali righe, con quali valori, e se si può confermare. Non
// è una scelta grafica messa in un modulo per finta — è la parte verificabile, e un test la esercita
// invece di leggere una regex sul JSX (che è come si era nascosto il bottone della coda, [[coda-visibile]]).
//
// ═══ LE DUE REGOLE CHE QUESTO MODULO GARANTISCE ══════════════════════════════════════════════════════
//
//   1. NESSUN NUMERO INVENTATO. Un campo che non si può leggere vale `null` e si scrive «N/D». Mai uno
//      zero, mai un trattino che sembri un valore, mai il valore della gamba precedente. `Number('')`
//      fa 0 e uno zero in un riepilogo d'ordine si legge come un prezzo — è lo stesso difetto già
//      corretto nel pannello manuale ([[campo-vuoto-non-e-zero]]).
//
//   2. SE MANCA UN DATO ESSENZIALE, NON SI CONFERMA. `completo` è falso e il pulsante resta spento.
//      Questa condizione si SOMMA ai gate esistenti, non li sostituisce: `canReview` continua a
//      decidere da solo, e questo può solo spegnere il pulsante, mai accenderlo.
//
// ═══ COSA NON FA ═════════════════════════════════════════════════════════════════════════════════════
// Non valida. Non decide se un prezzo incrocia o è in banda: quel verdetto arriva già fatto da
// `priceVerdict` (lib/maker/book-view), la stessa funzione che il server rigira prima di inviare. Qui si
// decide solo COSA MOSTRARE e SE I DATI CI SONO — un secondo giudizio sarebbe un secondo posto da cui
// divergere, che è la classe di difetto che questo progetto passa il tempo a togliere.

/** Un numero utilizzabile. `null`, `undefined` e `NaN` non sono numeri: non valgono zero. */
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Quello che si scrive quando un valore non c'è. Uguale ovunque, e mai confondibile con un numero. */
const ASSENTE = 'N/D';

const cents = (p) => (fin(p) ? `${(p * 100).toFixed(2)}¢` : ASSENTE);
const money = (v) => (fin(v) ? `$${v.toFixed(2)}` : ASSENTE);

/**
 * I TRE ESITI POSSIBILI DI UN CONTROLLO, e sono tre, non due.
 * «Non verificabile» NON è «no»: un book illeggibile non è un book sicuro. Restituire `false` quando la
 * risposta non si conosce è esattamente il modo in cui un controllo diventa decorativo.
 */
function esito(v) {
  if (v === true) return { testo: 'SÌ', noto: true, valore: true };
  if (v === false) return { testo: 'no', noto: true, valore: false };
  return { testo: 'non verificabile', noto: false, valore: null };
}

/**
 * IL RIEPILOGO COMPATTO.
 *
 * @param {object} a
 *   title        il nome del mercato
 *   marketId     l'id, per l'ancoraggio nei test e nel DOM
 *   book         'yes' | 'no' — il lato
 *   price        il prezzo REALE che verrebbe inviato (dal piano o digitato), mai un ripiego
 *   size         le share REALI
 *   distanceCents distanza dal mid, in centesimi
 *   bandRadiusCents il raggio premiante pubblicato dal venue
 *   verdict      l'oggetto di `priceVerdict`: {level, crosses, outOfBand, messages}
 *   legIdx/legsTotal  la gamba corrente, se il piano ne prevede più d'una
 *   fonte        'piano' | 'digitato' — DA DOVE vengono prezzo e size
 *
 * @returns {{righe:Array, completo:boolean, mancanti:string[], notional:number|null,
 *            incrocia:object, inBanda:object, lato:string|null}}
 */
function riepilogoOrdine({
  title = null, marketId = null, book = null, price = null, size = null,
  distanceCents = null, bandRadiusCents = null, verdict = null,
  legIdx = null, legsTotal = null, fonte = 'digitato',
} = {}) {
  // ── I DATI ESSENZIALI ───────────────────────────────────────────────────────────────────────────
  // Essenziale = senza questo non si sa cosa si sta per inviare. Un prezzo di 0, una size di 0 e un
  // lato assente non sono valori: sono l'assenza di un valore, e vanno trattati come tale.
  const mancanti = [];
  const lato = book === 'yes' || book === 'no' ? `BUY ${book.toUpperCase()}` : null;
  if (!lato) mancanti.push('lato');
  if (!fin(price) || price <= 0 || price >= 1) mancanti.push('prezzo');
  if (!fin(size) || size <= 0) mancanti.push('size');

  const notional = fin(price) && fin(size) && price > 0 && size > 0 ? +(price * size).toFixed(6) : null;

  const incrocia = esito(verdict ? verdict.crosses === true : null);
  // `outOfBand` è già a tre valori nella sua sorgente: true, false, null. Si gira l'orientamento —
  // la domanda mostrata è «è in banda?» — senza schiacciare il null su un booleano.
  const inBanda = esito(verdict == null || verdict.outOfBand == null ? null : verdict.outOfBand === false);

  const righe = [];
  if (fin(legIdx) && fin(legsTotal) && legsTotal > 1) {
    righe.push({ k: 'gamba', v: `${legIdx + 1} di ${legsTotal}`, tono: 'neutro', chiave: 'gamba' });
  }
  righe.push({ k: 'mercato', v: title || ASSENTE, tono: 'neutro', chiave: 'mercato' });
  righe.push({ k: 'lato', v: lato || ASSENTE, tono: lato ? 'neutro' : 'bad', chiave: 'lato' });
  righe.push({
    k: 'prezzo',
    v: fin(price) && price > 0 && price < 1 ? String(price) : ASSENTE,
    nota: fonte === 'piano' ? 'dal piano' : null,
    tono: fin(price) && price > 0 && price < 1 ? 'neutro' : 'bad',
    chiave: 'prezzo',
  });
  righe.push({
    k: 'size',
    v: fin(size) && size > 0 ? `${size} share` : ASSENTE,
    tono: fin(size) && size > 0 ? 'neutro' : 'bad',
    chiave: 'size',
  });
  righe.push({ k: 'controvalore', v: money(notional), tono: notional == null ? 'bad' : 'forte', chiave: 'controvalore' });
  righe.push({
    k: 'distanza dal mid',
    v: fin(distanceCents) ? `${distanceCents.toFixed(2)}¢` : ASSENTE,
    nota: fin(bandRadiusCents) ? `banda ±${bandRadiusCents.toFixed(2)}¢` : 'banda non pubblicata',
    tono: 'neutro', chiave: 'distanza',
  });
  // ── I DUE CONTROLLI, IN CHIARO ──────────────────────────────────────────────────────────────────
  // Erano il motivo per cui bisognava scorrere fino al book: adesso sono due righe, e dicono anche
  // quando la risposta non si conosce.
  righe.push({
    k: 'incrocia il book',
    v: incrocia.testo,
    tono: incrocia.valore === true ? 'bad' : incrocia.noto ? 'ok' : 'warn',
    chiave: 'incrocia',
  });
  righe.push({
    k: 'in banda reward',
    v: inBanda.testo,
    tono: inBanda.valore === true ? 'ok' : inBanda.valore === false ? 'warn' : 'warn',
    chiave: 'in-banda',
  });

  return {
    righe, mancanti, completo: mancanti.length === 0,
    notional, incrocia, inBanda, lato, marketId,
  };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/maker/riepilogo-ordine').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  const val = (r, chiave) => (r.righe.find((x) => x.chiave === chiave) || {}).v;

  const buono = {
    title: 'Republican Senate exactly 7', marketId: '0x9c0c', book: 'yes',
    price: 0.78, size: 24.7, distanceCents: 1.5, bandRadiusCents: 2.25,
    verdict: { level: 'ok', crosses: false, outOfBand: false, messages: [] },
    fonte: 'piano',
  };

  // ── I VALORI SONO QUELLI VERI ───────────────────────────────────────────────────────────────────
  const r = riepilogoOrdine(buono);
  ok('il prezzo mostrato è quello del piano, non un ripiego', val(r, 'prezzo') === '0.78');
  ok('  ed è dichiarato che viene dal piano',
    r.righe.find((x) => x.chiave === 'prezzo').nota === 'dal piano');
  ok('la size è quella del piano', val(r, 'size') === '24.7 share');
  ok('il lato è quello del piano', val(r, 'lato') === 'BUY YES');
  ok('il controvalore è prezzo × size, non un numero a parte', val(r, 'controvalore') === '$19.27');
  ok('la distanza dal mid c è, con la banda accanto',
    val(r, 'distanza') === '1.50¢' && /±2\.25¢/.test(r.righe.find((x) => x.chiave === 'distanza').nota));
  ok('«incrocia il book» → no', val(r, 'incrocia') === 'no');
  ok('«in banda reward» → SÌ', val(r, 'in-banda') === 'SÌ');
  ok('con tutti i dati, si può confermare', r.completo === true && r.mancanti.length === 0);

  // ── NIENTE PLACEHOLDER, NIENTE ZERO ─────────────────────────────────────────────────────────────
  // Il caso che conta: i campi vuoti. `Number('')` fa 0, e uno zero in un riepilogo d'ordine si legge
  // come un prezzo vero.
  const vuoto = riepilogoOrdine({ ...buono, price: NaN, size: NaN });
  ok('campi vuoti → prezzo «N/D», MAI «0»', val(vuoto, 'prezzo') === 'N/D');
  ok('  size «N/D», MAI «0 share»', val(vuoto, 'size') === 'N/D');
  ok('  controvalore «N/D», MAI «$0.00»', val(vuoto, 'controvalore') === 'N/D');
  ok('  E NON SI PUÒ CONFERMARE', vuoto.completo === false);
  ok('  con i mancanti dichiarati', vuoto.mancanti.includes('prezzo') && vuoto.mancanti.includes('size'));

  const zero = riepilogoOrdine({ ...buono, price: 0, size: 0 });
  ok('uno zero esplicito è trattato come assenza, non come valore',
    val(zero, 'prezzo') === 'N/D' && val(zero, 'size') === 'N/D' && zero.completo === false);

  ok('un prezzo fuori da (0,1) non è un prezzo',
    riepilogoOrdine({ ...buono, price: 1 }).completo === false
    && riepilogoOrdine({ ...buono, price: -0.2 }).completo === false);
  ok('senza lato non si conferma', riepilogoOrdine({ ...buono, book: null }).completo === false);

  // ── I TRE ESITI, E IL TERZO NON È «NO» ──────────────────────────────────────────────────────────
  const incrocia = riepilogoOrdine({ ...buono, verdict: { level: 'bad', crosses: true, outOfBand: false, messages: [] } });
  ok('un prezzo che incrocia lo dice, in rosso',
    val(incrocia, 'incrocia') === 'SÌ' && incrocia.righe.find((x) => x.chiave === 'incrocia').tono === 'bad');
  const fuori = riepilogoOrdine({ ...buono, verdict: { level: 'warn', crosses: false, outOfBand: true, messages: [] } });
  ok('fuori banda lo dice', val(fuori, 'in-banda') === 'no');
  const ignoto = riepilogoOrdine({ ...buono, verdict: { level: 'unknown', crosses: false, outOfBand: null, messages: [] } });
  ok('BANDA NON VERIFICABILE non diventa «no» né «SÌ»', val(ignoto, 'in-banda') === 'non verificabile');
  ok('  e non è verde', ignoto.righe.find((x) => x.chiave === 'in-banda').tono === 'warn');
  const senzaVerdetto = riepilogoOrdine({ ...buono, verdict: null });
  ok('senza verdetto, entrambi i controlli dicono «non verificabile»',
    val(senzaVerdetto, 'incrocia') === 'non verificabile' && val(senzaVerdetto, 'in-banda') === 'non verificabile');
  ok('  e nessuno dei due è verde',
    senzaVerdetto.righe.filter((x) => (x.chiave === 'incrocia' || x.chiave === 'in-banda') && x.tono === 'ok').length === 0);

  // ── LE GAMBE ────────────────────────────────────────────────────────────────────────────────────
  ok('con due gambe si dice a quale si è',
    val(riepilogoOrdine({ ...buono, legIdx: 1, legsTotal: 2 }), 'gamba') === '2 di 2');
  ok('con una gamba sola non si aggiunge rumore',
    riepilogoOrdine({ ...buono, legIdx: 0, legsTotal: 1 }).righe.every((x) => x.chiave !== 'gamba'));

  // ── LA COMPATTEZZA È UNA PROPRIETÀ, NON UN'INTENZIONE ───────────────────────────────────────────
  ok('il riepilogo di una gamba sta in 9 righe o meno', r.righe.length <= 9, );
  ok('  e nessuna riga è un paragrafo', r.righe.every((x) => String(x.v).length <= 80));

  console.log('riepilogo-ordine: ' + n + ' assertions passed');
  return n;
}

module.exports = { riepilogoOrdine, esito, ASSENTE, selfcheck };

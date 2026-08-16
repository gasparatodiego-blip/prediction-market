'use strict';
// lib/maker/esenzione-rinnovo.js — IL PAVIMENTO DI PROFONDITÀ NON SI APPLICA A UN RINNOVO. PURO.
//
// ═══ LA DECISIONE, E LA SUA RAGIONE ══════════════════════════════════════════════════════════════════
// Decisione dell'operatore, 16 agosto 2026. Il pavimento di profondita' (`motore-unico.pavimentoDepth`,
// `DEPTH_FLOOR_PCT_OF_AVG`) esiste per limitare l'APERTURA di esposizione su un libro troppo sottile.
// Un RINNOVO non apre niente: sposta un ordine che e' gia' a libro, alla stessa size o meno.
//
// Il termine di paragone giusto non e' «nessuna esposizione» — quella non e' un'opzione, l'ordine c'e'
// gia' — ma **«la gamba muore e restiamo direzionali»**. Fra le due, restare direzionali su un book
// sottile e' il rischio peggiore: una coppia incompleta e' una scommessa secca sull'esito, mentre una
// coppia completa su un book sottile e' solo capitale che rende poco.
//
// ⚠ MISURATO PRIMA DI DECIDERE, non dopo: 34 `anomalia-rinnovo-fermato` in 22 minuti su
// `0xf2b0c93903a1…`, tutte della forma «RINNOVO DOVUTO E FERMATO (179s alla scadenza):
// profondita-insufficiente». Sei ordini sono morti per GTD in quella finestra, e quel mercato e'
// rimasto **a gamba singola** — cioe' esattamente il rischio che il pavimento avrebbe dovuto evitare,
// prodotto dal pavimento stesso. E' §5.2 p.21, annotato il 13 agosto e osservato dal vivo oggi.
//
// ⚠ IL PAVIMENTO RESTA PIENO SULLE APERTURE. Questo modulo non lo abbassa, non lo scala e non lo
// tocca: risponde a UNA domanda — «questo ordine sta rinnovando qualcosa?» — e a nient'altro.
//
// ═══ SICURA PER COSTRUZIONE, NON PER DICHIARAZIONE ═══════════════════════════════════════════════════
// E' la stessa forma di `esenzione-chiusura`: non ci si fida di un flag, si rifa' l'aritmetica
// sull'ordine esatto contro gli ordini VIVI letti dal venue. Quattro condizioni, tutte necessarie:
//
//   ① ESISTE UN ORDINE VIVO da rinnovare, sullo STESSO mercato, token e lato. Se non c'e', questo
//      ordine non sta sostituendo niente: e' un'apertura, e il pavimento si applica per intero.
//   ② LA SIZE NON AUMENTA. Un rinnovo che ingrossa la gamba sta aprendo la differenza, e la
//      differenza e' esattamente cio' che il pavimento deve giudicare. Riduzioni ammesse.
//   ③ IL NOZIONALE NON AUMENTA. La size da sola non basta: stessa size a prezzo piu' alto e' piu'
//      capitale a riposo, quindi piu' esposizione. Si guardano entrambi, e il piu' stretto vince.
//   ④ FAIL-CLOSED SU TUTTO IL RESTO. Lista non leggibile, prezzo o size illeggibili sull'ordine
//      vecchio o sul nuovo, token o lato non determinabili ⇒ **apertura**. «Non ho potuto stabilire
//      cosa sto rinnovando» non e' «sto rinnovando».
//
// ⚠ NON SI CHIEDE CHE L'ORDINE VECCHIO STIA SCADENDO. Sarebbe una condizione in piu' e sembrerebbe
// piu' stretta, ma non lo e': un rinnovo anticipato e uno all'ultimo secondo hanno lo stesso effetto
// sull'esposizione, e legare l'esenzione a un orologio la renderebbe fragile proprio nel caso in cui
// serve — quando il ciclo e' in ritardo. Cio' che rende l'esenzione sicura e' che la size e il
// nozionale non crescano, non QUANDO avviene la sostituzione.

const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => { const n = Number(x); return fin(n) ? n : null; };

/**
 * @param a.conditionId / a.tokenId / a.side   l'ordine che sta per partire
 * @param a.size / a.price                     la sua size e il suo prezzo
 * @param a.ordiniVivi                         gli ordini a riposo letti dal VENUE; `null` ⇒ apertura
 * @returns {{esente:boolean, motivo:string, sostituisce:string|null}}
 */
function provaRinnovo(a = {}) {
  const no = (motivo) => ({ esente: false, motivo, sostituisce: null });
  const c = norm(a.conditionId), t = norm(a.tokenId), s = norm(a.side);
  if (!t || !s) return no('token o lato non leggibili: non si puo\' stabilire cosa si starebbe rinnovando ⇒ apertura');
  const size = num(a.size), price = num(a.price);
  if (size === null || size <= 0 || price === null || price <= 0) {
    return no('size o prezzo del nuovo ordine non verificati ⇒ apertura');
  }
  // ④ La lista deve esserci. `null` e `[]` sono due cose diverse e vanno distinte: la prima e' «non ho
  // guardato», la seconda e' «ho guardato e il libro e' vuoto» — e su un libro vuoto non c'e' niente
  // da rinnovare, quindi entrambe portano ad «apertura», ma con motivi diversi che si contano a parte.
  if (!Array.isArray(a.ordiniVivi)) {
    return no('ordini vivi non leggibili: non si puo\' dimostrare che questo sostituisca qualcosa ⇒ apertura');
  }

  const candidati = a.ordiniVivi.filter((o) => {
    if (!o) return false;
    if (c && norm(o.marketId || o.conditionId) !== c) return false;
    return norm(o.tokenId || o.asset_id || o.assetId) === t && norm(o.side) === s;
  });
  if (!candidati.length) {
    return no('nessun ordine vivo su questo mercato, token e lato: non sta rinnovando niente ⇒ apertura');
  }

  // Se ce ne fosse piu' di uno saremmo davanti a un doppione (che `doppioni.js` toglie). Si prende il
  // PIU' GRANDE come termine di paragone: e' il confronto piu' severo per chi chiede l'esenzione,
  // perche' rende piu' difficile dimostrare che la size non aumenta... no, il contrario. Si prende il
  // PIU' PICCOLO, che e' il confronto piu' severo: se il nuovo sta sotto al piu' piccolo, sta sotto a
  // tutti. Con un solo candidato — il caso normale — le due scelte coincidono.
  let vecchio = null;
  for (const o of candidati) {
    const os = num(o.sizeRemaining != null ? o.sizeRemaining : o.size);
    const op = num(o.price);
    if (os === null || os <= 0 || op === null || op <= 0) {
      return no(`l'ordine vivo ${norm(o.orderId).slice(0, 12) || '(senza id)'} ha size o prezzo illeggibili:`
        + ' il confronto non e\' calcolabile ⇒ apertura');
    }
    if (!vecchio || os < vecchio.size) vecchio = { size: os, price: op, id: norm(o.orderId) };
  }

  // ② la size non aumenta
  if (size > vecchio.size + 1e-9) {
    return no(`la size sale da ${vecchio.size} a ${size}: la differenza APRE esposizione nuova,`
      + ' ed e\' esattamente cio\' che il pavimento deve giudicare ⇒ apertura');
  }
  // ③ il nozionale non aumenta
  const nuovoNoz = +(size * price).toFixed(6);
  const vecchioNoz = +(vecchio.size * vecchio.price).toFixed(6);
  if (nuovoNoz > vecchioNoz + 1e-9) {
    return no(`il nozionale sale da $${vecchioNoz.toFixed(2)} a $${nuovoNoz.toFixed(2)} (stessa size o meno,`
      + ' ma prezzo piu\' alto): piu\' capitale a riposo e\' piu\' esposizione ⇒ apertura');
  }

  return { esente: true, sostituisce: vecchio.id || null,
    // ⚠ IL PREZZO DI RIFERIMENTO E' LA META' CHE RENDE L'ESENZIONE SICURA QUANDO IL PREZZO NON E'
    // ANCORA DECISO. Chi chiama nel ciclo di riprezzo conosce la size (invariata) ma NON il prezzo
    // nuovo: lo sceglie il motore dopo. Senza questo numero l'esenzione varrebbe anche per un livello
    // piu' caro, cioe' per piu' nozionale a riposo — la regola ③ violata proprio nel percorso che
    // l'esenzione serve. Il motore accetta un livello solo se `price <= prezzoMassimo`.
    prezzoMassimo: vecchio.price, sizeMassima: vecchio.size,
    motivo: `rinnovo provato: sostituisce ${vecchio.id ? `${vecchio.id.slice(0, 12)}…` : 'un ordine vivo'}`
      + ` sullo stesso token e lato, size ${size} ≤ ${vecchio.size} e nozionale $${nuovoNoz.toFixed(2)}`
      + ` ≤ $${vecchioNoz.toFixed(2)}. Non apre esposizione: sposta un ordine gia' a libro.` };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ esenzione-rinnovo ════');
  const vivo = (size, price, id = '0xold') => ({ orderId: id, marketId: '0xM', tokenId: 'tokA', side: 'BUY', size, price });
  const base = { conditionId: '0xM', tokenId: 'tokA', side: 'BUY' };

  // ① esiste un ordine vivo da rinnovare
  ok('stessa size e stesso prezzo ⇒ ESENTE (il rinnovo puro)',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).esente === true);
  ok('  e dichiara quale ordine sta sostituendo',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).sostituisce === '0xold');
  ok('nessun ordine vivo su token+lato ⇒ APERTURA, il pavimento si applica',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [] }).esente === false);
  ok('  un ordine vivo sull\'ALTRO token non conta',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [{ ...vivo(56, 0.65), tokenId: 'tokB' }] }).esente === false);
  ok('  ne\' uno sul lato opposto',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [{ ...vivo(56, 0.65), side: 'SELL' }] }).esente === false);
  ok('  ne\' uno di un altro mercato',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [{ ...vivo(56, 0.65), marketId: '0xALTRO' }] }).esente === false);

  // ② la size non aumenta
  ok('size PIU\' PICCOLA ⇒ esente (una riduzione e\' ammessa)',
    provaRinnovo({ ...base, size: 40, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).esente === true);
  ok('size PIU\' GRANDE ⇒ APERTURA',
    provaRinnovo({ ...base, size: 57, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).esente === false);
  ok('  e il motivo dice che la differenza apre esposizione',
    /APRE esposizione/.test(provaRinnovo({ ...base, size: 57, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).motivo));

  // ③ il nozionale non aumenta
  ok('stessa size a prezzo PIU\' BASSO ⇒ esente',
    provaRinnovo({ ...base, size: 56, price: 0.60, ordiniVivi: [vivo(56, 0.65)] }).esente === true);
  ok('stessa size a prezzo PIU\' ALTO ⇒ APERTURA (piu\' capitale a riposo)',
    provaRinnovo({ ...base, size: 56, price: 0.70, ordiniVivi: [vivo(56, 0.65)] }).esente === false);
  ok('size minore ma nozionale MAGGIORE ⇒ APERTURA: si guardano entrambi',
    provaRinnovo({ ...base, size: 50, price: 0.90, ordiniVivi: [vivo(56, 0.65)] }).esente === false);

  // ④ fail-closed
  ok('ordini vivi `null` (non letti) ⇒ APERTURA',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: null }).esente === false);
  ok('  e il motivo distingue «non ho guardato» da «libro vuoto»',
    /non leggibili/.test(provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: null }).motivo)
    && /non sta rinnovando niente/.test(provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [] }).motivo));
  ok('token non leggibile ⇒ APERTURA',
    provaRinnovo({ ...base, tokenId: null, size: 56, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).esente === false);
  ok('lato non leggibile ⇒ APERTURA',
    provaRinnovo({ ...base, side: null, size: 56, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).esente === false);
  ok('size del nuovo ordine non verificata ⇒ APERTURA',
    provaRinnovo({ ...base, size: null, price: 0.65, ordiniVivi: [vivo(56, 0.65)] }).esente === false);
  ok('prezzo dell\'ordine VECCHIO illeggibile ⇒ APERTURA (il confronto non e\' calcolabile)',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [vivo(56, null)] }).esente === false);
  ok('  e `Number(null) === 0` non entra dalla porta di servizio',
    provaRinnovo({ ...base, size: 56, price: 0.65, ordiniVivi: [vivo(56, 0)] }).esente === false);

  // Con piu' candidati si confronta col PIU' PICCOLO: se il nuovo sta sotto a quello, sta sotto a tutti.
  ok('con due gemelli si confronta col piu\' piccolo (il piu\' severo)',
    provaRinnovo({ ...base, size: 45, price: 0.65, ordiniVivi: [vivo(56, 0.65, '0xa'), vivo(40, 0.65, '0xb')] }).esente === false
    && provaRinnovo({ ...base, size: 40, price: 0.65, ordiniVivi: [vivo(56, 0.65, '0xa'), vivo(40, 0.65, '0xb')] }).esente === true);

  console.log(`\nesenzione-rinnovo: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { provaRinnovo, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

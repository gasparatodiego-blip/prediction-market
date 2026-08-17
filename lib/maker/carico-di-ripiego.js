'use strict';
// lib/maker/carico-di-ripiego.js — IL CARICO QUANDO IL VENUE NON L'HA ANCORA PUBBLICATO. PURO.
//
// ═══ IL BUCO, MISURATO ═══════════════════════════════════════════════════════════════════════════════
// Il 16 agosto, su ENTRAMBI i fill avversi — 15:19:41 su FL-27 e 16:43:27 su FL-02 — il primo ciclo di
// chiusura dopo il riempimento ha risposto:
//     `skip-no-entry-price — prezzo medio di carico non leggibile dal venue`
//     `merge-livello-3 — il lato riempito e' costato 0.0¢: con un margine di -1¢ non resta spazio`
// **2 occorrenze su 2 fill: il 100%.** Per un ciclo intero — 60 secondi, la cadenza di `closeTask` —
// ne' la scala d'uscita ne' il merge possono fare alcunche', perche' `position.avgPrice` non e' ancora
// pubblicato dal venue. Non e' un caso limite: e' il comportamento normale nell'istante che conta di
// piu', cioe' quello in cui la gamba e' appena diventata nuda.
//
// ⚠ E NON E' SOLO UN RITARDO: `decidiLivello` con `prezzoCarico` illeggibile non si limita ad
// astenersi — calcola `il lato riempito e' costato 0.0¢` e da li' deduce un tetto negativo. Un numero
// non letto che diventa zero e' la sesta occorrenza di `Number(null) === 0` in questo repo.
//
// ═══ LA REGOLA: SI USA IL PREZZO CHE CONOSCIAMO GIA' ═════════════════════════════════════════════════
// Un fill nasce da un NOSTRO ordine limite, e il prezzo di quell'ordine lo conosciamo prima del venue.
// Per un BUY limite il prezzo pagato e' **al piu'** il prezzo dell'ordine: il venue puo' migliorarlo,
// mai peggiorarlo. Quindi il nostro prezzo e' un **limite superiore** del carico vero.
//
// ⚠ ED E' PRUDENTE IN ENTRAMBE LE DIREZIONI, che e' la ragione per cui si puo' usare senza aspettare:
//   · sul MERGE il tetto del secondo lato e' `tettoCoppia − carico`: un carico sovrastimato stringe il
//     tetto, quindi si compra la controparte piu' a buon mercato o non si compra. Mai il contrario.
//   · sull'USCITA il bersaglio e' `carico × (1 + profitPct)`: un carico sovrastimato ALZA il bersaglio,
//     quindi non si vende piu' a buon mercato di quanto si venderebbe col numero vero.
// In nessuno dei due casi la stima puo' far perdere piu' del dato vero. Sbaglia sempre verso l'inerzia.
//
// ⚠ NON SOSTITUISCE MAI IL DATO VERO: si usa SOLO quando `avgPrice` non e' leggibile, e nel momento in
// cui il venue lo pubblica il ripiego sparisce. La provenienza viaggia sempre nel verdetto (`fonte`),
// perche' un numero stimato che si presenta come misurato e' peggio di un numero assente.
//
// ⚠ ZERO `require`: stessa disciplina di `copertura-gambe`, `presa-di-profitto`, `ripristino-gambe`.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const prezzoValido = (p) => fin(p) && p > 0 && p < 1;

/**
 * IL CARICO DA USARE, con la sua provenienza.
 *
 * @param a.avgPrice        quello del venue: se c'e', vince sempre
 * @param a.tokenId         il token della posizione
 * @param a.ordiniVivi      gli ordini a riposo: un BUY ANCORA VIVO sullo stesso token e' il residuo
 *                          dell'ordine che ha prodotto il fill — il suo prezzo e' il nostro limite
 * @param a.ultimoNostroPrezzo  ripiego di secondo livello: il prezzo dell'ultimo BUY che abbiamo
 *                          piazzato su quel token (lo legge il chiamante, che ha il giornale)
 * @returns {{carico:number|null, fonte:string, stimato:boolean, motivo:string}}
 */
function caricoDaUsare(a = {}) {
  const no = (motivo) => ({ carico: null, fonte: 'nessuna', stimato: false, motivo });

  // ① IL DATO VERO. Non si stima mai quando si puo' misurare.
  if (prezzoValido(a.avgPrice)) {
    return { carico: Number(a.avgPrice), fonte: 'venue', stimato: false,
      motivo: 'prezzo medio di carico pubblicato dal venue' };
  }

  const tok = norm(a.tokenId);
  if (!tok) return no('token non identificabile: non si stima un carico su una posizione che non si sa quale sia');

  // ② IL RESIDUO ANCORA A LIBRO. E' il caso del fill PARZIALE, ed e' quello in cui la stima e' piu'
  // solida: l'ordine che ha prodotto il fill e' ancora li' e porta il suo prezzo.
  // ⚠ Si prende il prezzo PIU' ALTO fra i BUY vivi su quel token: fra piu' candidati si sceglie quello
  // che sovrastima di piu', perche' e' la direzione prudente (vedi la nota in testa).
  let daResiduo = null;
  for (const o of (Array.isArray(a.ordiniVivi) ? a.ordiniVivi : [])) {
    if (!o) continue;
    if (String(o.side || '').toUpperCase() !== 'BUY') continue;
    if (norm(o.tokenId ?? o.asset_id ?? o.assetId) !== tok) continue;
    const p = Number(o.price);
    if (!prezzoValido(p)) continue;
    if (daResiduo === null || p > daResiduo) daResiduo = p;
  }
  if (daResiduo !== null) {
    return { carico: daResiduo, fonte: 'residuo-a-libro', stimato: true,
      motivo: `carico non pubblicato dal venue: si usa il prezzo del nostro BUY ancora a riposo su questo token`
        + ` (${(daResiduo * 100).toFixed(1)}¢). Per un limite e' un limite SUPERIORE del prezzo pagato` };
  }

  // ③ L'ULTIMO NOSTRO PREZZO. E' il caso del fill TOTALE: l'ordine e' sparito, ma il prezzo a cui lo
  // avevamo messo lo sappiamo. Lo passa il chiamante, che e' l'unico ad avere il giornale.
  if (prezzoValido(a.ultimoNostroPrezzo)) {
    return { carico: Number(a.ultimoNostroPrezzo), fonte: 'ultimo-ordine-nostro', stimato: true,
      motivo: `carico non pubblicato dal venue: si usa il prezzo dell'ultimo BUY che abbiamo piazzato su`
        + ` questo token (${(Number(a.ultimoNostroPrezzo) * 100).toFixed(1)}¢), che per un limite`
        + ' e\' un limite SUPERIORE del prezzo pagato' };
  }

  // ⚠ NESSUN RIPIEGO ⇒ SI RESTA COME PRIMA. Non si inventa un carico dal mid, dal book o dal nulla: un
  // carico sbagliato in DIFETTO farebbe vendere sotto costo e comprare la controparte troppo cara,
  // cioe' esattamente i due errori che questo modulo esiste per non commettere.
  return no('carico non pubblicato dal venue e nessun prezzo nostro disponibile: non si stima');
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ carico-di-ripiego ════');

  const buy = (tokenId, price, side = 'BUY') => ({ orderId: 'o', tokenId, side, price, size: 50 });

  const vero = caricoDaUsare({ avgPrice: 0.54, tokenId: 'T', ordiniVivi: [buy('T', 0.71)], ultimoNostroPrezzo: 0.9 });
  ok('il dato del venue vince SEMPRE', vero.carico === 0.54 && vero.fonte === 'venue' && vero.stimato === false);

  const res = caricoDaUsare({ avgPrice: null, tokenId: 'T', ordiniVivi: [buy('T', 0.2)] });
  ok('senza venue si usa il residuo a libro', res.carico === 0.2 && res.fonte === 'residuo-a-libro');
  ok('  ed e dichiarato come STIMATO', res.stimato === true);

  ok('fra piu BUY vivi si prende il piu ALTO (direzione prudente)',
    caricoDaUsare({ tokenId: 'T', ordiniVivi: [buy('T', 0.2), buy('T', 0.24), buy('T', 0.18)] }).carico === 0.24);
  ok('un SELL sullo stesso token NON e un carico',
    caricoDaUsare({ tokenId: 'T', ordiniVivi: [buy('T', 0.2, 'SELL')] }).carico === null);
  ok('un BUY su un ALTRO token non e un carico',
    caricoDaUsare({ tokenId: 'T', ordiniVivi: [buy('ALTRO', 0.2)] }).carico === null);

  const ult = caricoDaUsare({ tokenId: 'T', ordiniVivi: [], ultimoNostroPrezzo: 0.54 });
  ok('senza residuo si usa l ultimo nostro prezzo', ult.carico === 0.54 && ult.fonte === 'ultimo-ordine-nostro');
  ok('  ma il residuo ha la precedenza sull ultimo prezzo',
    caricoDaUsare({ tokenId: 'T', ordiniVivi: [buy('T', 0.2)], ultimoNostroPrezzo: 0.9 }).fonte === 'residuo-a-libro');

  ok('nessuna fonte ⇒ null, e NON si inventa', caricoDaUsare({ tokenId: 'T' }).carico === null);
  ok('token non identificabile ⇒ null', caricoDaUsare({ ordiniVivi: [buy('T', 0.2)] }).carico === null);
  for (const brutto of [0, 1, -0.1, 1.5, NaN, null, undefined, '0.5']) {
    ok(`prezzo non valido (${JSON.stringify(brutto)}) ⇒ non si usa`,
      caricoDaUsare({ tokenId: 'T', ultimoNostroPrezzo: brutto }).carico === null);
  }
  ok('un avgPrice a ZERO non passa per «vero»: e Number(null) travestito',
    caricoDaUsare({ avgPrice: 0, tokenId: 'T', ordiniVivi: [buy('T', 0.2)] }).fonte === 'residuo-a-libro');

  console.log(`\ncarico-di-ripiego selfcheck: ${p} verdi, ${f} rossi`);
  return f === 0;
}

module.exports = { caricoDaUsare, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

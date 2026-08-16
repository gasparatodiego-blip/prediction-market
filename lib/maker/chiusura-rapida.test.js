'use strict';
// lib/maker/chiusura-rapida.test.js — IL TETTO DELLA COPPIA È UN LIMITE DURO, E SI VERIFICA DUE VOLTE.
//
// ⚠ IL NUMERO NON È SCRITTO QUI, ED È DELIBERATO (12 agosto 2026). Questo file asseriva `110` in nove
// punti, quindi il giorno in cui l'operatore ha spostato il tetto a 120 sarebbero diventati nove test
// rossi che non segnalavano nessun difetto. Ciò che va difeso non è il valore — è che il CONFINE
// MORDA DOVE DEVE: nessuna gamba proposta porta la coppia sopra il tetto in vigore, il taker si ferma
// esattamente lì, e il limit ci si appoggia sopra. Tutte le asserzioni derivano quindi il tetto da
// `CR.TETTO_COPPIA_CENTS` (e i prezzi di carico dalle fixture), e restano vere a qualunque valore.
//
// Tre regole decise dall'operatore il 9 agosto 2026, provate qui:
//   1 · su un fill che lascia un lato scoperto si compra la controparte da TAKER, fino al costo della
//       coppia dichiarato dal tetto — SOPRA LA PARI, quindi con una perdita certa: e' il prezzo della
//       chiusura immediata del rischio direzionale, non un effetto collaterale;
//   2 · quello che il book non copre sotto il tetto va a LIMIT al prezzo che tiene la coppia AL tetto;
//   3 · dopo una fusione il capitale liberato torna a fare liquidita' sullo stesso mercato, se il
//       mercato regge ancora i suoi gate.
//
// E una che NON e' stata toccata: `skip-no-target` (auto-close.js:208) resta dov'era. Nasce da
// `planExit`, cioe' dal piano di VENDITA d'uscita, e vale per qualunque posizione — non solo per una
// coppia scoperta. Le regole qui sotto agiscono PRIMA, sul completamento della coppia, e non passano da
// quella riga: se completano, l'uscita non serve; se rinunciano, `skip-no-target` decide come sempre.

const fs = require('fs');
const path = require('path');
const CR = require('./chiusura-rapida');
const AC = require('./auto-close');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}
const cents = (x) => +(x * 100).toFixed(2);
// IL TETTO IN VIGORE, letto dal modulo. Ogni asserzione di confine passa di qui.
const T = CR.TETTO_COPPIA_CENTS;

console.log('── 1 · BOOK LIQUIDO: IL TAKER COMPLETA SUBITO, SOTTO IL TETTO');
{
  // Carico 65¢: il massimo pagabile per l'altro lato è (tetto − 65)¢.
  const p = CR.pianificaChiusuraRapida({
    prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: [{ price: 0.30, size: 60 }, { price: 0.32, size: 80 }],
  });
  ok('il piano è utilizzabile', p.ok === true, p.motivo);
  ok('  taker per TUTTE le share mancanti', p.taker && p.taker.size === 100, p.taker && String(p.taker.size));
  ok('  al prezzo del livello PEGGIORE preso (si esegue a quello o meglio)', p.taker.prezzo === 0.32);
  ok('  e nessun limit, perché non resta niente', p.limite === null);
  ok(`  TETTO RISPETTATO: coppia a ${cents(0.65 + p.taker.prezzo)}¢ ≤ ${T}¢`, cents(0.65 + p.taker.prezzo) <= T);
  ok('  e il controllo indipendente conferma', CR.rispettaIlTetto(p, 0.65) === true);
  ok('  niente resta scoperto', p.scoperto === 0);
}

console.log('\n── 2 · BOOK SOTTILE (BUCO DI LIQUIDITÀ): TAKER FIN DOVE ARRIVA, IL RESTO A LIMIT');
{
  // ⚠ LA FIXTURE SI COSTRUISCE DAL TETTO, non da un numero scritto a mano: il secondo livello sta
  // DELIBERATAMENTE 5¢ sopra il massimo pagabile, così il confine morde qualunque sia il tetto. Con
  // il tetto a 110 questo livello valeva 50¢; a 120 vale 60¢. È la stessa prova, ritarata.
  const CARICO = 0.65;
  const MAX_PAGABILE = +((T / 100) - CARICO).toFixed(2);   // il prezzo che tiene la coppia AL tetto
  const TROPPO_CARO = +(MAX_PAGABILE + 0.05).toFixed(2);
  const p = CR.pianificaChiusuraRapida({
    prezzoCarico: CARICO, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: [{ price: 0.30, size: 40 }, { price: TROPPO_CARO, size: 500 }],
  });
  ok('il piano è utilizzabile', p.ok === true, p.motivo);
  ok('  il taker si FERMA al livello sotto il tetto', p.taker && p.taker.size === 40 && p.taker.prezzo === 0.30,
    p.taker && `${p.taker.size}@${p.taker.prezzo}`);
  ok(`  NON prende il livello a ${cents(TROPPO_CARO)}¢ (la coppia sarebbe ${cents(CARICO + TROPPO_CARO)}¢, sopra ${T}¢)`,
    p.taker.prezzo <= MAX_PAGABILE);
  ok('  il resto va a LIMIT', p.limite && p.limite.size === 60, p.limite && String(p.limite.size));
  ok(`  al prezzo che tiene la coppia AL tetto: ${T} − 65 = ${T - 65}¢`, cents(0.65 + p.limite.prezzo) === T);
  ok('  TETTO RISPETTATO su entrambe le gambe',
    cents(0.65 + p.taker.prezzo) <= T && cents(0.65 + p.limite.prezzo) <= T,
    `taker ${cents(0.65 + p.taker.prezzo)}¢ · limit ${cents(0.65 + p.limite.prezzo)}¢`);
  ok('  e niente resta scoperto', p.scoperto === 0);

  // Nessun livello sotto il tetto: tutto a limit, nessun taker.
  const q = CR.pianificaChiusuraRapida({
    prezzoCarico: CARICO, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: [{ price: TROPPO_CARO, size: 500 }],
  });
  ok('book tutto sopra il tetto ⇒ nessun taker', q.ok === true && q.taker === null, q.motivo);
  ok('  e tutte le share a limit al tetto', q.limite && q.limite.size === 100 && cents(CARICO + q.limite.prezzo) === T);

  // Scala assente: non si inventa un taker.
  const z = CR.pianificaChiusuraRapida({ prezzoCarico: CARICO, manca: 100, tick: 0.01, minSize: 20, asksAltroLato: null });
  ok('scala ask assente ⇒ nessun taker, solo il limit al tetto',
    z.ok === true && z.taker === null && cents(CARICO + z.limite.prezzo) === T);
}

console.log('\n── 3 · IL TETTO NON SI SFORA MAI, NEMMENO DI UNA FRAZIONE DI TICK');
{
  // L'arrotondamento del limite deve andare GIÙ. Il carico è scelto perché il massimo esatto NON cada
  // su un multiplo del tick: con tick 0.1 il prezzo esatto è (T/100 − carico), e arrotondare su
  // sforerebbe il tetto di una frazione di tick. Il carico si deriva dal tetto perché la proprietà
  // «non è un multiplo di 0.1» resti vera a qualunque valore.
  const caricoTickGrosso = +((T / 100) - 0.45).toFixed(2);
  const p = CR.pianificaChiusuraRapida({ prezzoCarico: caricoTickGrosso, manca: 100, tick: 0.1, minSize: 1, asksAltroLato: [] });
  ok('tick grosso: il limite si arrotonda GIÙ', p.limite.prezzo === 0.4, String(p.limite.prezzo));
  ok('  e arrotondare SU avrebbe sforato', cents(caricoTickGrosso + 0.5) > T);
  ok(`  coppia a ${cents(caricoTickGrosso + p.limite.prezzo)}¢, sotto il tetto`, cents(caricoTickGrosso + p.limite.prezzo) <= T);

  // Sweep esaustivo: nessuna combinazione deve produrre una gamba oltre il tetto.
  let sforati = 0; let prodotti = 0;
  for (const carico of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 0.99]) {
    for (const tick of [0.1, 0.01, 0.001]) {
      for (const askP of [0.01, 0.1, 0.3, 0.45, 0.7, 0.99]) {
        const r = CR.pianificaChiusuraRapida({ prezzoCarico: carico, manca: 100, tick, minSize: 1,
          asksAltroLato: [{ price: askP, size: 100 }] });
        if (!r.ok) continue;
        for (const g of [r.taker, r.limite]) {
          if (!g) continue;
          prodotti += 1;
          if (cents(carico + g.prezzo) > T + 1e-9) sforati += 1;
        }
      }
    }
  }
  ok(`sweep su ${prodotti} gambe proposte: ZERO oltre il tetto`, sforati === 0, `sforati ${sforati}`);

  // Carico già sopra il tetto ⇒ non si propone niente. Il carico si DERIVA dal tetto (5¢ oltre), così
  // la prova resta la stessa a qualunque valore: con il tetto a 110 valeva 1,15, a 120 vale 1,25.
  const alto = CR.pianificaChiusuraRapida({ prezzoCarico: +((T / 100) + 0.05).toFixed(2), manca: 100, tick: 0.01, minSize: 1, asksAltroLato: [] });
  ok('carico oltre il tetto ⇒ nessuna gamba', alto.ok === false, alto.motivo.slice(0, 60));
  // Ingressi non leggibili ⇒ niente, mai un prezzo indovinato.
  for (const [nome, arg] of [['tick', { tick: null }], ['carico', { prezzoCarico: null }], ['manca', { manca: 0 }]]) {
    const r = CR.pianificaChiusuraRapida({ prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 1, asksAltroLato: [], ...arg });
    ok(`${nome} non leggibile ⇒ nessuna proposta`, r.ok === false);
  }
  // Il VALORE si asserisce una volta sola, qui, ed e' il punto in cui un cambio del tetto va notato
  // di proposito. Ovunque altro si deriva.
  // ⚠ 110 (fino all'11/08) → 120 (12/08) → **101** (15/08, decisione dell'operatore: un tetto solo per
  // tutta la scala d'uscita, allineato a `strategia-merge.MERGE_TETTO_COPPIA_CENTS`). Vedi l'header di
  // `chiusura-rapida.js` per la misura di §5-bis p.162 che lo sostiene.
  ok(`il tetto di difetto è ${T}¢ (decisione dell'operatore, 15 agosto 2026: era 120)`, T === 101);
  ok('  e coincide col tetto del merge, che è la decisione presa',
    T === require('./strategia-merge').MERGE_TETTO_COPPIA_CENTS);
  ok('  ed è sopra la pari: un tetto a 100 renderebbe la chiusura possibile solo quando il mercato la regala', T > 100);
  ok('  e un valore assurdo da .env viene scartato',
    CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: '90' }) === T && CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: 'x' }) === T
    && CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: '999' }) === T);
  ok('  e un valore VALIDO nel range viene invece rispettato',
    CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: '105' }) === 105);
  ok('  ma uno sensato passa', CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: '105' }) === 105);
}

console.log('\n── 4 · IL GATE RIFÀ L\'ARITMETICA: IL TETTO È CONTROLLATO DUE VOLTE');
{
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('l\'eccezione BUY esige `completaCoppia` esplicito', /spec\.completaCoppia === true/.test(mo));
  ok('  e i due numeri del limite', /prezzoCaricoCoppia/.test(mo) && /tettoCoppiaCents/.test(mo));
  ok('  e RICONTROLLA il tetto invece di fidarsi', /\(caricoCoppia \+ price\) \* 100 <= tettoCoppia/.test(mo));
  ok('  con il tetto vincolato a [100, 200]', /tettoCoppia >= 100 && tettoCoppia <= 200/.test(mo));
  ok('la vecchia eccezione SELL è intatta', /lato === 'SELL' && spec\.attraversaApposta === true/.test(mo));
  ok('un BUY senza dichiarazione resta rifiutato (nessun default)',
    !/attraversaApposta = \(lato === 'BUY'\)/.test(mo));
  // La chiusura rapida passa davvero i tre campi.
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('auto-close li dichiara tutti e tre sul taker',
    /completaCoppia: true, prezzoCaricoCoppia: prezzoCarico, tettoCoppiaCents: piano\.tettoCents/.test(ac));
  ok('  e il limit NON li dichiara (non incrocia)', /\{ inCoda: true \}/.test(ac));
  ok('l\'ordine è: prima i livelli del merge (che guadagnano), poi la chiusura rapida (che paga)',
    ac.indexOf('CHIUSURA RAPIDA: L\'ULTIMA CARTA') > ac.indexOf('I DUE TENTATIVI, IN ORDINE'));
}

console.log('\n── 5 · RIPOSIZIONAMENTO DOPO LA CHIUSURA');
{
  const rules = (bidYes, bidNo, extra = {}) => ({
    readable: true, tick: 0.01, minSize: 20, maxSpreadCents: 4.5,
    books: { yes: { scoringMid: 0.5, bestBid: bidYes }, no: { scoringMid: 0.5, bestBid: bidNo } }, ...extra,
  });

  // (a) mercato ancora valido ⇒ due gambe, una per lato.
  const mandati = [];
  AC.riposizionaDopoChiusura({ marketId: '0xaa', rules: rules(0.49, 0.51), capitaleUsd: 100,
    deps: { placeOrder: async (o) => { mandati.push(o); return { ok: true, orderId: 'o' + mandati.length }; } } })
    .then((r) => {
      ok('(a) mercato valido ⇒ riposizionato', r.ok === true, r.motivo);
      ok('  due gambe, una per lato', mandati.length === 2 && mandati.map((m) => m.book).sort().join(',') === 'no,yes');
      ok('  entrambe BUY, in coda (mai taker)', mandati.every((m) => m.side === 'BUY' && m.inCoda === true && !m.attraversaApposta));
      ok('  un tick DIETRO il miglior bid', mandati.find((m) => m.book === 'yes').price === 0.48
        && mandati.find((m) => m.book === 'no').price === 0.50);
      ok('  il capitale si divide fra i due lati', Math.abs(mandati[0].price * mandati[0].size - 50) < 1);
    });

  // (b) mercato non più valido ⇒ niente, e il capitale torna al ciclo normale.
  for (const [nome, r] of [
    ['regole non leggibili', { readable: false }],
    ['tick non leggibile', rules(0.49, 0.51, { tick: null })],
    ['miglior bid assente su un lato', rules(0.49, null)],
  ]) {
    const m = [];
    AC.riposizionaDopoChiusura({ marketId: '0xaa', rules: r, capitaleUsd: 100,
      deps: { placeOrder: async (o) => { m.push(o); return { ok: true }; } } })
      .then((res) => ok(`(b) ${nome} ⇒ NESSUN riposizionamento`, res.ok === false && m.length === 0, res.motivo.slice(0, 55)));
  }
  // Capitale troppo piccolo per il minimo del venue.
  AC.riposizionaDopoChiusura({ marketId: '0xaa', rules: rules(0.49, 0.51), capitaleUsd: 4,
    deps: { placeOrder: async () => ({ ok: true }) } })
    .then((r) => ok('(b) sotto il minimo del venue ⇒ niente', r.ok === false, r.motivo.slice(0, 55)));

  // (c) NESSUN LOOP: se il gate rifiuta, si rinuncia e basta — un tentativo solo.
  let tentativi = 0;
  AC.riposizionaDopoChiusura({ marketId: '0xaa', rules: rules(0.49, 0.51), capitaleUsd: 100,
    deps: { placeOrder: async () => { tentativi += 1; return { ok: false, gate: 'mai-primo-sul-libro', reason: 'fuori banda' }; } } })
    .then((r) => {
      ok('(c) rifiutato da mai-primo ⇒ si rinuncia', r.ok === false, r.motivo.slice(0, 55));
      ok('  UN tentativo per gamba, nessun ritentativo', tentativi === 2, `${tentativi} chiamate`);
    });

  // (d) una gamba sola passata ⇒ si RITIRA: mezza coppia è la stessa esposizione da cui si è usciti.
  let cancellati = 0; let n = 0;
  AC.riposizionaDopoChiusura({ marketId: '0xaa', rules: rules(0.49, 0.51), capitaleUsd: 100,
    deps: {
      placeOrder: async () => { n += 1; return n === 1 ? { ok: true, orderId: 'x1' } : { ok: false, gate: 'mai-primo-sul-libro' }; },
      cancelOrder: async () => { cancellati += 1; return { ok: true }; },
    } })
    .then((r) => {
      ok('(d) una gamba sola ⇒ ritirata, non lasciata direzionale', r.ok === false && cancellati === 1, r.motivo.slice(0, 60));
    });

  // ── IL RIPOSIZIONAMENTO È AGGANCIATO A DUE PERCORSI DAL 9 AGOSTO 2026 ──────────────────────────
  // Era solo il ramo della FUSIONE. Adesso parte anche quando a chiudere la gestione del fill è stata
  // la gamba aggressiva (rimasuglio o riposizionamento scoperto): «il fill è stato gestito» vale in
  // entrambi i casi. L'asserzione difende la proprietà nuova, che è più larga di quella vecchia.
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('è agganciato all\'esito «fuso»', /esito\.esito === 'fuso'[\s\S]*?riposizionamenti\.push/.test(ac));
  ok('  ed è agganciato anche agli esiti terminali della gestione del fill',
    /esito\.rimasuglio === true \|\| esito\.riposizionamentoScoperto === true[\s\S]{0,400}?riposizionamenti\.push/.test(ac));
  ok('  e NON parte su un «piazzato» dei Livelli 1/2 ordinari, dove la coppia è ancora aperta',
    !/action: `merge-livello-\$\{esito\.livello\}`[^\n]*\n\s*riposizionamenti\.push/.test(ac));
  ok('  ma eseguito a fine ciclo, così non può far fallire la chiusura', /for \(const r of riposizionamenti\)/.test(ac));
  ok('  e un\'eccezione non rompe il giro', /catch \(e\) \{ esitoRip = \{ ok: false/.test(ac));
}

console.log('\n── 6 · skip-no-target NON È STATO TOCCATO');
{
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  // ⚠ SI DIFENDE LA PROPRIETA', NON LA RIGA. La versione precedente fotografava il testo esatto
  // `return out('skip', 'no-target', plan.reason);` ed e' diventata rossa quando §5 p.138 ha aggiunto
  // al verdetto i campi dell'urgenza — senza che niente di cio' che il test protegge fosse cambiato.
  // E' la classe di difetto «test che fotografa il codice invece della proprieta'», gia' costata tre
  // volte in questo repo. La proprieta' e' doppia: `no-target` esiste ancora, e nasce ancora dal
  // FALLIMENTO di `planExit`, cioe' dal piano di VENDITA e non dal completamento della coppia.
  ok('la riga di skip-no-target è ancora quella', /out\('skip', 'no-target'/.test(ac));
  // I COMMENTI SI TOLGONO PRIMA DI MISURARE UNA DISTANZA NEL SORGENTE: altrimenti la finestra misura
  // quanto e' lungo il commento, non quanto sono vicine le due istruzioni. E' la regola di §5.3.
  const acNudo = ac.replace(/^\s*\/\/.*$/gm, '');
  ok('  e nasce ancora da planExit (il piano di VENDITA, non del completamento)',
    /const plan = planExit\(\{[\s\S]{0,600}if \(!plan\.ok\)[\s\S]{0,200}out\('skip', 'no-target'/.test(acNudo));
  // La chiusura rapida sta in `completaCoppia`, che e' una funzione DIVERSA da `decideClose` (dove vive
  // skip-no-target). Non e' una questione di ordine nel file: sono due percorsi distinti, e il test lo
  // verifica cercando i due nomi nelle due funzioni giuste.
  const idxDecide = ac.indexOf('function decideClose');
  const idxCompleta = ac.indexOf('async function completaCoppia');
  const idxSkip = ac.indexOf("out('skip', 'no-target'");
  const idxRapida = ac.indexOf('LA CHIUSURA RAPIDA: L\'ULTIMA CARTA');
  ok('skip-no-target vive in decideClose', idxSkip > idxDecide && idxSkip < idxCompleta);
  ok('la chiusura rapida vive in completaCoppia: due percorsi distinti', idxRapida > idxCompleta);
}


console.log('\n── 7 · IL LATO SCOPERTO NON RESTA MUTO (riposizionamento, 9 agosto 2026)');
{
  // (a) banda SOPRA il carico: il lato posseduto va a +1%, la controparte a limit.
  const a = CR.pianificaRiposizionamentoScoperto({ prezzoCarico: 0.60, sizePosseduta: 100, manca: 100,
    bandaHi: 0.64, tick: 0.01, minSize: 20 });
  ok('(a) lato posseduto riposizionato a +1%', a.latoPosseduto && a.latoPosseduto.prezzo === 0.61, a.latoPosseduto && String(a.latoPosseduto.prezzo));
  ok('  SOPRA il carico', a.latoPosseduto.prezzo > 0.60);
  ok('  e DENTRO la banda', a.latoPosseduto.prezzo <= 0.64);
  // Il prezzo della controparte è quello che tiene la coppia AL tetto, quindi si deriva: era 0,50 col
  // tetto a 110, è 0,60 a 120. Ciò che va difeso è che la coppia finisca ESATTAMENTE al tetto e mai oltre.
  ok('  e la controparte va a limit al prezzo che tiene la coppia AL tetto',
    a.controparte && a.controparte.size === 100 && cents(0.60 + a.controparte.prezzo) === T,
    a.controparte && String(a.controparte.prezzo));
  ok('  con la coppia entro il tetto', cents(0.60 + a.controparte.prezzo) <= T);

  // (b) +1% cadrebbe FUORI banda ⇒ si usa il prezzo più vicino DENTRO banda, mai oltre.
  const b = CR.pianificaRiposizionamentoScoperto({ prezzoCarico: 0.60, sizePosseduta: 100, manca: 100,
    bandaHi: 0.605, tick: 0.005, minSize: 20 });
  ok('(b) +1% fuori banda ⇒ si scende al tetto della banda', b.latoPosseduto.prezzo === 0.605, String(b.latoPosseduto.prezzo));
  ok('  mai oltre la banda', b.latoPosseduto.prezzo <= 0.605);
  ok('  e comunque sopra il carico', b.latoPosseduto.prezzo > 0.60);

  // (c) IL CASO CHE HA MOTIVATO LA REGOLA: banda interamente SOTTO il carico. I tre vincoli sono
  //     incompatibili, e la funzione lo DICHIARA invece di inventare un prezzo — ma propone comunque
  //     la controparte, che e' sempre prezzabile. Il silenzio si riduce, non sparisce.
  const c = CR.pianificaRiposizionamentoScoperto({ prezzoCarico: 0.59, sizePosseduta: 21, manca: 21,
    bandaHi: 0.51, tick: 0.01, minSize: 20 });
  ok('(c) banda sotto il carico ⇒ lato posseduto NON riposizionato', c.latoPosseduto === null);
  ok('  e il motivo dice perché i tre vincoli non stanno insieme',
    /sotto il prezzo di carico/.test(c.latoPossedutoMotivo) && /non si vende in perdita/i.test(c.latoPossedutoMotivo));
  ok('  ma la controparte viene proposta lo stesso', c.ok === true && c.controparte && c.controparte.size === 21);
  ok('  quindi il mercato NON resta senza alcun ordine', c.controparte !== null);

  // (d) nessun prezzo proposto sul lato posseduto viola mai i due vincoli duri — sweep.
  let viol = 0; let prop = 0;
  for (const carico of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    for (const hi of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      for (const tick of [0.1, 0.01, 0.001]) {
        const r = CR.pianificaRiposizionamentoScoperto({ prezzoCarico: carico, sizePosseduta: 100, manca: 100, bandaHi: hi, tick, minSize: 1 });
        if (!r.latoPosseduto) continue;
        prop += 1;
        if (r.latoPosseduto.prezzo <= carico + 1e-9 || r.latoPosseduto.prezzo > hi + 1e-9) viol += 1;
      }
    }
  }
  ok(`(d) sweep su ${prop} prezzi proposti: ZERO sotto il carico o fuori banda`, viol === 0, `violazioni ${viol}`);

  // (e) NESSUN CONFLITTO con la chiusura rapida: sta dopo, non in parallelo.
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('(e) il riposizionamento sta DOPO la chiusura rapida nel flusso',
    ac.indexOf('ULTIMO PASSO: NON RESTARE MUTI') > ac.indexOf('LA CHIUSURA RAPIDA: L\'ULTIMA CARTA'));
  ok('  e se il taker completa non ci si arriva (si torna prima)',
    /return \{ esito: 'piazzato'[\s\S]{0,300}chiusuraRapida: true/.test(ac));
  ok('  il lato posseduto si VENDE, la controparte si COMPRA',
    /side: vende \? 'SELL' : 'BUY'/.test(ac));
  // AGGIORNATO IL 9 AGOSTO 2026 (CLAUDE.md §5 punto 59). Prima si pretendeva la stringa letterale
  // `inCoda: true` su entrambe le gambe. L'intento — MAI TAKER — resta intatto e si verifica meglio
  // qui sotto; ma «entrambe in coda» non è più vero di proposito: quando il lato posseduto è muto per
  // banda-sotto-carico, la controparte va PRIMA ASSOLUTA in banda, perché è l'unica cosa che può
  // chiudere la posizione. È un'eccezione mirata, legata a `primoAssoluto`, e vale solo per la gamba
  // che COMPRA.
  ok('  mai taker: nessuna delle due attraversa lo spread',
    !/attraversaApposta: true[\s\S]{0,200}riposizionamento scoperto/.test(ac));
  ok('  il lato posseduto resta SEMPRE in coda', /const primoAssoluto = !vende && g\.primoAssoluto === true;/.test(ac));
  ok('  e la controparte esce dalla coda solo se marcata primo assoluto',
    /\.\.\.\(primoAssoluto \? \{\} : \{ inCoda: true \}\)/.test(ac));
}

setTimeout(() => {
  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}, 400);

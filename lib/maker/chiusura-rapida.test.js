'use strict';
// lib/maker/chiusura-rapida.test.js — IL TETTO DI 110¢ È UN LIMITE DURO, E SI VERIFICA DUE VOLTE.
//
// Tre regole decise dall'operatore il 9 agosto 2026, provate qui:
//   1 · su un fill che lascia un lato scoperto si compra la controparte da TAKER, fino a un costo della
//       coppia di 110¢ — sopra la pari, quindi con una perdita certa fino a 10¢: e' il prezzo della
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

console.log('── 1 · BOOK LIQUIDO: IL TAKER COMPLETA SUBITO, SOTTO IL TETTO');
{
  // Carico 65¢: il massimo pagabile per l'altro lato è 110 − 65 = 45¢.
  const p = CR.pianificaChiusuraRapida({
    prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: [{ price: 0.30, size: 60 }, { price: 0.32, size: 80 }],
  });
  ok('il piano è utilizzabile', p.ok === true, p.motivo);
  ok('  taker per TUTTE le share mancanti', p.taker && p.taker.size === 100, p.taker && String(p.taker.size));
  ok('  al prezzo del livello PEGGIORE preso (si esegue a quello o meglio)', p.taker.prezzo === 0.32);
  ok('  e nessun limit, perché non resta niente', p.limite === null);
  ok('  TETTO RISPETTATO: coppia a ' + cents(0.65 + p.taker.prezzo) + '¢ ≤ 110¢', cents(0.65 + p.taker.prezzo) <= 110);
  ok('  e il controllo indipendente conferma', CR.rispettaIlTetto(p, 0.65) === true);
  ok('  niente resta scoperto', p.scoperto === 0);
}

console.log('\n── 2 · BOOK SOTTILE (BUCO DI LIQUIDITÀ): TAKER FIN DOVE ARRIVA, IL RESTO A LIMIT');
{
  // Il secondo livello sta a 50¢: 65 + 50 = 115¢, SOPRA il tetto. Il taker deve fermarsi al primo.
  const p = CR.pianificaChiusuraRapida({
    prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: [{ price: 0.30, size: 40 }, { price: 0.50, size: 500 }],
  });
  ok('il piano è utilizzabile', p.ok === true, p.motivo);
  ok('  il taker si FERMA al livello sotto il tetto', p.taker && p.taker.size === 40 && p.taker.prezzo === 0.30,
    p.taker && `${p.taker.size}@${p.taker.prezzo}`);
  ok('  NON prende il livello a 50¢ (coppia sarebbe 115¢)', p.taker.prezzo < 0.45);
  ok('  il resto va a LIMIT', p.limite && p.limite.size === 60, p.limite && String(p.limite.size));
  ok('  al prezzo che tiene la coppia AL tetto: 110 − 65 = 45¢', p.limite.prezzo === 0.45);
  ok('  TETTO RISPETTATO su entrambe le gambe',
    cents(0.65 + p.taker.prezzo) <= 110 && cents(0.65 + p.limite.prezzo) <= 110,
    `taker ${cents(0.65 + p.taker.prezzo)}¢ · limit ${cents(0.65 + p.limite.prezzo)}¢`);
  ok('  e niente resta scoperto', p.scoperto === 0);

  // Nessun livello sotto il tetto: tutto a limit, nessun taker.
  const q = CR.pianificaChiusuraRapida({
    prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: [{ price: 0.60, size: 500 }],
  });
  ok('book tutto sopra il tetto ⇒ nessun taker', q.ok === true && q.taker === null, q.motivo);
  ok('  e tutte le share a limit al tetto', q.limite && q.limite.size === 100 && q.limite.prezzo === 0.45);

  // Scala assente: non si inventa un taker.
  const z = CR.pianificaChiusuraRapida({ prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 20, asksAltroLato: null });
  ok('scala ask assente ⇒ nessun taker, solo il limit al tetto', z.ok === true && z.taker === null && z.limite.prezzo === 0.45);
}

console.log('\n── 3 · IL TETTO NON SI SFORA MAI, NEMMENO DI UNA FRAZIONE DI TICK');
{
  // L'arrotondamento del limite deve andare GIÙ. Con tick 0.1 e carico 0.65 il massimo esatto è 0.45 →
  // giù al tick = 0.4. Arrotondare su darebbe 0.5, cioè una coppia a 115¢.
  const p = CR.pianificaChiusuraRapida({ prezzoCarico: 0.65, manca: 100, tick: 0.1, minSize: 1, asksAltroLato: [] });
  ok('tick grosso: il limite si arrotonda GIÙ', p.limite.prezzo === 0.4, String(p.limite.prezzo));
  ok('  coppia a ' + cents(0.65 + p.limite.prezzo) + '¢, sotto il tetto', cents(0.65 + p.limite.prezzo) <= 110);

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
          if (cents(carico + g.prezzo) > 110 + 1e-9) sforati += 1;
        }
      }
    }
  }
  ok(`sweep su ${prodotti} gambe proposte: ZERO oltre il tetto`, sforati === 0, `sforati ${sforati}`);

  // Carico già sopra il tetto ⇒ non si propone niente.
  const alto = CR.pianificaChiusuraRapida({ prezzoCarico: 1.15, manca: 100, tick: 0.01, minSize: 1, asksAltroLato: [] });
  ok('carico oltre il tetto ⇒ nessuna gamba', alto.ok === false, alto.motivo.slice(0, 60));
  // Ingressi non leggibili ⇒ niente, mai un prezzo indovinato.
  for (const [nome, arg] of [['tick', { tick: null }], ['carico', { prezzoCarico: null }], ['manca', { manca: 0 }]]) {
    const r = CR.pianificaChiusuraRapida({ prezzoCarico: 0.65, manca: 100, tick: 0.01, minSize: 1, asksAltroLato: [], ...arg });
    ok(`${nome} non leggibile ⇒ nessuna proposta`, r.ok === false);
  }
  ok('il tetto di difetto è 110¢', CR.TETTO_COPPIA_CENTS === 110);
  ok('  e un valore assurdo da .env viene scartato',
    CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: '90' }) === 110 && CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: 'x' }) === 110
    && CR.leggiTetto({ MAKER_TETTO_COPPIA_CENTS: '999' }) === 110);
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

  // Il riposizionamento è agganciato al ramo della FUSIONE, e gira FUORI dal ramo.
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('è agganciato all\'esito «fuso»', /esito\.esito === 'fuso'[\s\S]{0,900}?riposizionamenti\.push/.test(ac));
  ok('  ma eseguito a fine ciclo, così non può far fallire la chiusura', /for \(const r of riposizionamenti\)/.test(ac));
  ok('  e un\'eccezione non rompe il giro', /catch \(e\) \{ esitoRip = \{ ok: false/.test(ac));
}

console.log('\n── 6 · skip-no-target NON È STATO TOCCATO');
{
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('la riga di skip-no-target è ancora quella', /return out\('skip', 'no-target', plan\.reason\);/.test(ac));
  ok('  e nasce ancora da planExit (il piano di VENDITA, non del completamento)',
    /const plan = planExit\(\{[\s\S]{0,200}if \(!plan\.ok\) return out\('skip', 'no-target'/.test(ac));
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
  ok('  e la controparte va a limit', a.controparte && a.controparte.size === 100 && a.controparte.prezzo === 0.50);
  ok('  con la coppia entro il tetto', cents(0.60 + a.controparte.prezzo) <= 110);

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

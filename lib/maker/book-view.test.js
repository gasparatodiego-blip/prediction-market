#!/usr/bin/env node
'use strict';
// Unit test di lib/maker/book-view.js — l'aritmetica della vista del book e i giudizi sul prezzo.
// Nessuna rete, nessun file, nessun venue: si iniettano livelli e si guarda cosa esce.
//
// IL CASO CENTRALE E' UNA REGRESSIONE VERA, non un esempio inventato: i numeri del blocco «l'anomalia
// riprodotta» sono quelli letti da /tmp/clob-live-books.json il 2026-08-02 sul mercato
// «Bitcoin Up or Down - August 1, 7:30PM-7:45PM ET», dove min_incentive_size = 50 rendeva il primo
// livello (0.85 x 10.18 share) invisibile al programma premi e spingeva l'adjusted mid a 0.77 —
// cioe' SOTTO il miglior bid. E' la stessa forma di «MID 20.0¢ · BID 21.0¢ · ASK 22.0¢».

const B = require('./book-view');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ═══ L'ANOMALIA RIPRODOTTA ═══════════════════════════════════════════════════════════════════════════
console.log('\n── il caso reale: adjusted mid sotto il miglior bid (book sottile + min_incentive_size)');
{
  const v = B.bookView({
    levels: { bids: [{ price: 0.85, size: 10.18 }, { price: 0.77, size: 999 }], asks: [] },
    bestBid: 0.85, bestAsk: null,
    scoringMid: 0.77,      // cio' che agent34 pubblica come `mid`: adjustedMid, filtrato di polvere
    minSize: 50,
  });
  ok('il mid mostrato NON e mai sotto il miglior bid', !(v.mid < v.bestBid), `mid ${v.mid} vs bid ${v.bestBid}`);
  ok('un book con solo bid non spaccia quel prezzo per un midpoint', v.midKind === 'one-sided-bid', v.midKind);
  ok('il mid di scoring viene trasportato invariato', v.scoringMid === 0.77, String(v.scoringMid));
  ok('la divergenza col mid di scoring e dichiarata', v.midDiffersFromScoring === true);
  ok('e viene detto che cade FUORI dal tocco', v.scoringMidOutsideTouch === true);
  ok('con una nota che nomina min_incentive_size', v.midNotes.some((n) => n.includes('min_incentive_size')));
}

console.log('\n── la forma esatta segnalata: mid 20 con bid 21 e ask 22 non e piu producibile');
{
  // Un book in cui i primi livelli sono briciole sotto la soglia: il filtro anti-polvere ancora
  // l'adjusted mid a 0.18/0.22 e produce 0.20, cioe' sotto il miglior bid di 0.21.
  const v = B.bookView({
    levels: {
      bids: [{ price: 0.21, size: 8 }, { price: 0.18, size: 700 }],
      asks: [{ price: 0.22, size: 900 }],
    },
    bestBid: 0.21, bestAsk: 0.22, scoringMid: 0.20, minSize: 50,
  });
  ok('mid mostrato = midpoint del tocco', v.mid === 0.215, `${v.mid}`);
  ok('sta FRA bid e ask', v.mid >= v.bestBid && v.mid <= v.bestAsk, `${v.bestBid} <= ${v.mid} <= ${v.bestAsk}`);
  ok('lo scoring mid fuori tocco e segnalato, non nascosto', v.scoringMidOutsideTouch === true);
}

console.log('\n── la nota sul mid di scoring compare quando conta, non a ogni mezzo tick');
{
  // Mezzo tick di scarto (0.1¢) su una banda da ±2.25¢: non sposta nessuna decisione. Una nota qui
  // comparirebbe su quasi ogni mercato, e una nota che c e sempre non viene piu letta.
  const tiny = B.bookView({
    levels: { bids: [{ price: 0.206, size: 900 }], asks: [{ price: 0.207, size: 900 }] },
    scoringMid: 0.207, minSize: 200,
  });
  ok('scarto 0.1c: nessuna nota', tiny.midNotes.length === 0 && tiny.midDiffersFromScoring === false);

  // Mezzo centesimo su un raggio di 2.25¢ e' oltre un quinto della banda: si dice.
  const real = B.bookView({
    levels: { bids: [{ price: 0.18, size: 900 }], asks: [{ price: 0.19, size: 900 }] },
    scoringMid: 0.19, minSize: 200,
  });
  ok('scarto 0.5c: la nota compare', real.midDiffersFromScoring === true && real.midNotes.length > 0);

  // Fuori dal tocco si avvisa SEMPRE, anche se lo scarto e minuscolo: e la condizione segnalata.
  const out = B.bookView({
    levels: { bids: [{ price: 0.21, size: 900 }], asks: [{ price: 0.22, size: 900 }] },
    scoringMid: 0.2099, minSize: 200,
  });
  ok('fuori dal tocco: nota anche con scarto sotto soglia', out.scoringMidOutsideTouch === true && out.midNotes.length > 0);
}

// ═══ INVARIANTE GENERALE ═════════════════════════════════════════════════════════════════════════════
console.log('\n── invariante: con due lati, bid <= mid <= ask. Sempre.');
{
  let worst = null;
  for (let i = 0; i < 2000; i++) {
    const bb = +(0.01 + Math.random() * 0.9).toFixed(3);
    const ba = +(bb + 0.001 + Math.random() * 0.2).toFixed(3);
    const v = B.bookView({
      levels: { bids: [{ price: bb, size: 1 + Math.random() * 900 }], asks: [{ price: ba, size: 1 + Math.random() * 900 }] },
      // uno scoringMid deliberatamente assurdo: non deve poter influenzare il mid mostrato
      scoringMid: Math.random() < 0.5 ? bb - 0.3 : ba + 0.3,
      minSize: 50,
    });
    if (!(v.mid >= v.bestBid - 1e-9 && v.mid <= v.bestAsk + 1e-9)) { worst = v; break; }
  }
  ok('2000 book casuali, nessun mid fuori dal tocco', worst === null, worst ? JSON.stringify(worst) : '');
}

// ═══ LA SCALA ════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── ordinamento e cumulato');
{
  // Ingresso in ordine CRESCENTE per i bid e DECRESCENTE per gli ask: e' esattamente come li consegna
  // la REST GET /book del CLOB, dove il tocco e' l'ULTIMO elemento. Se non si riordinasse, il book
  // apparirebbe capovolto su quel percorso e dritto sull'altro.
  const v = B.bookView({
    levels: {
      bids: [{ price: 0.10, size: 50 }, { price: 0.20, size: 100 }, { price: 0.30, size: 200 }],
      asks: [{ price: 0.60, size: 70 }, { price: 0.50, size: 30 }, { price: 0.40, size: 10 }],
    },
    minSize: null,
  }, { levels: 3 });
  ok('i bid partono dal piu alto', v.levels.bids.map((r) => r.price).join(',') === '0.3,0.2,0.1');
  ok('gli ask partono dal piu basso', v.levels.asks.map((r) => r.price).join(',') === '0.4,0.5,0.6');
  ok('il tocco esce dalla scala, non dal campo separato', v.bestBid === 0.3 && v.bestAsk === 0.4);
  ok('il cumulato bid si somma dal tocco in fuori', v.levels.bids.map((r) => r.total).join(',') === '200,300,350');
  ok('il cumulato ask si somma dal tocco in fuori', v.levels.asks.map((r) => r.total).join(',') === '10,40,110');
  ok('il mid e il midpoint del tocco', v.mid === 0.35, String(v.mid));
}

console.log('\n── un book piu sottile del richiesto mostra quello che c e, senza righe inventate');
{
  const v = B.bookView({ levels: { bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 20 }] } }, { levels: 5 });
  ok('nessuna riga di riempimento', v.levels.bids.length === 1 && v.levels.asks.length === 1);
  ok('i livelli reali sono contati', v.levels.bidCount === 1 && v.levels.askCount === 1);
  ok('e la vista non e dichiarata troncata', v.levels.truncated === false);
}
console.log('\n── un book piu profondo del richiesto dichiara di essere troncato');
{
  const bids = Array.from({ length: 9 }, (_, i) => ({ price: +(0.5 - i * 0.01).toFixed(2), size: 10 }));
  const v = B.bookView({ levels: { bids, asks: [{ price: 0.51, size: 5 }] } }, { levels: 5 });
  ok('mostra esattamente 5 righe', v.levels.bids.length === 5);
  ok('ma dice che i livelli reali sono 9', v.levels.bidCount === 9);
  ok('e marca la vista come troncata', v.levels.truncated === true);
}
console.log('\n── i livelli a size 0 sono cancellazioni, non righe');
{
  const v = B.bookView({ levels: { bids: [{ price: 0.4, size: 0 }, { price: 0.39, size: 12 }], asks: [] } });
  ok('la riga a size 0 non compare', v.levels.bids.length === 1 && v.levels.bids[0].price === 0.39);
  ok('e non diventa il tocco', v.bestBid === 0.39, String(v.bestBid));
}
console.log('\n── i prezzi in stringa (formato del filo CLOB) vengono letti');
{
  const v = B.bookView({ levels: { bids: [{ price: '0.21', size: '300' }], asks: [{ price: '0.22', size: '400' }] } });
  ok('il tocco e numerico', v.bestBid === 0.21 && v.bestAsk === 0.22);
  ok('e il mid pure', v.mid === 0.215, String(v.mid));
}

// ═══ L'INCROCIO, SUI DUE LATI ════════════════════════════════════════════════════════════════════════
console.log('\n── BUY YES: incrocia quando il prezzo raggiunge il miglior ask');
{
  const at = B.crossesBook({ price: 0.22, bestBid: 0.21, bestAsk: 0.22, side: 'BUY' });
  const over = B.crossesBook({ price: 0.25, bestBid: 0.21, bestAsk: 0.22, side: 'BUY' });
  const under = B.crossesBook({ price: 0.21, bestBid: 0.21, bestAsk: 0.22, side: 'BUY' });
  ok('a prezzo = miglior ask incrocia', at.crosses === true);
  ok('sopra il miglior ask incrocia', over.crosses === true);
  ok('sotto il miglior ask non incrocia', under.crosses === false);
}
console.log('\n── BUY NO: identico, ma misurato sul book NO — non su 1 meno il book YES');
{
  // Book NO reale, indipendente: bid 0.77 / ask 0.79. Il complemento del book YES (bid 0.21/ask 0.22)
  // darebbe 0.78/0.79: un ordine a 0.78 sarebbe «sicuro» secondo lo specchio e INCROCEREBBE davvero
  // secondo il book vero. Il test blocca proprio quella scorciatoia.
  const real = B.priceVerdict({ price: 0.79, bestBid: 0.77, bestAsk: 0.79, scoringMid: 0.78, bandRadiusCents: 2.25, side: 'BUY' });
  ok('a prezzo = miglior ask del book NO il verdetto e rosso', real.level === 'bad');
  ok('e dice che incrocia', real.crosses === true);
  ok('col numero dell ask del book NO nel testo', real.messages.join(' ').includes('79'), real.messages[0]);

  const safe = B.priceVerdict({ price: 0.76, bestBid: 0.77, bestAsk: 0.79, scoringMid: 0.78, bandRadiusCents: 2.25, side: 'BUY' });
  ok('sotto il bid del book NO il verdetto e verde', safe.level === 'ok', safe.messages[0]);
  ok('e non segnala incrocio', safe.crosses === false);
}

console.log('\n── fuori banda reward: GIALLO, non rosso — non matura, ma si piazza');
{
  // Il rosso in questo pannello significa «l ordine non e quello che credi». Un ordine fuori banda e
  // esattamente quello che l operatore ha chiesto: riposa sul book come previsto e costa i premi. Il
  // verso della copertura e cambiato con il prodotto — prima questo caso BLOCCAVA il piazzamento.
  const v = B.priceVerdict({ price: 0.10, bestBid: 0.20, bestAsk: 0.22, scoringMid: 0.21, bandRadiusCents: 2.25, side: 'BUY' });
  ok('il verdetto e giallo', v.level === 'warn', v.level);
  ok('non per incrocio', v.crosses === false);
  ok('ma per la banda', v.outOfBand === true);
  ok('e lo dice esplicitamente', v.messages.join(' ').includes('banda reward'));
  ok('dichiarando che e un avviso e non un blocco', /avviso, non un blocco/.test(v.messages.join(' ')));
}
console.log('\n── dentro banda e senza incrocio: verde');
{
  const v = B.priceVerdict({ price: 0.20, bestBid: 0.20, bestAsk: 0.22, scoringMid: 0.21, bandRadiusCents: 2.25, side: 'BUY' });
  ok('verde', v.level === 'ok', v.messages[0]);
  ok('e dice che resta maker', v.messages.join(' ').includes('maker'));
}
console.log('\n── un book illeggibile non e un book sicuro');
{
  const v = B.priceVerdict({ price: 0.20, bestBid: null, bestAsk: null, scoringMid: 0.21, bandRadiusCents: 2.25, side: 'BUY' });
  ok('non e verde', v.level !== 'ok', v.level);
}

// ═══ LA DISTANZA DAL MID ═════════════════════════════════════════════════════════════════════════════
// Si MISURA e si mostra su ogni riga del book. Non decide piu' nulla: `levelBlocked`, che rendeva inerti
// le righe sotto una soglia, e' stato rimosso insieme al cursore che lo governava.
console.log('\n── distanza dal mid: si misura, non blocca');
{
  ok('0.21 dista 1.5c da 0.225', B.distanceCents(0.21, 0.225) === 1.5, String(B.distanceCents(0.21, 0.225)));
  ok('e un valore assoluto, uguale sopra e sotto il mid',
    B.distanceCents(0.24, 0.225) === B.distanceCents(0.21, 0.225), '1.5c da entrambi i lati');
  ok('senza mid non si puo misurare, e lo dice con null', B.distanceCents(0.21, null) === null);
  ok('senza prezzo idem', B.distanceCents(null, 0.225) === null);
  // IL FILTRO NON ESISTE PIU: nessuna riga del book puo essere resa non selezionabile dalla distanza.
  ok('levelBlocked non e piu esportato', typeof B.levelBlocked === 'undefined', typeof B.levelBlocked);
}

console.log(`\n${fail === 0 ? '✓ TUTTO VERDE' : '✗ FALLITI'}: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

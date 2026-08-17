'use strict';
// lib/maker/attraversamento-scatta.test.js — L'ORDINE PARTE DAVVERO SENZA `post-only`?
//
// ═══ LA DOMANDA, E PERCHE' NON E' QUELLA DEL MODULO PURO ═════════════════════════════════════════════
// `attraversamento-uscita.js` sa gia' dire quando il permesso c'e' (17 asserzioni nel suo selfcheck).
// Ma il permesso non serve a niente se il campo sul filo resta `postOnly: true` — ed e' esattamente
// quello che e' successo per mesi: **il gate interno diceva si', il campo sul filo diceva no, e vinceva
// il filo** (§5-bis p.29, e i 146 SELL mai eseguiti del 16 agosto).
//
// Quindi qui si guarda **la spec che arriva a `placeOrder`**: `attraversaApposta` c'e' o no, `inCoda`
// c'e' o no. Non lo stato calcolato, non il verdetto: il campo.
//
// ⚠ E si esercita `runAutoCloseCycle` VERO. Una simulazione su una copia della logica non dimostra
// niente sulla logica che gira davvero (§5.3).
//
// Run: node lib/maker/attraversamento-scatta.test.js

const { runAutoCloseCycle } = require('./auto-close');
const { valutaAttraversamento } = require('./attraversamento-uscita');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const sez = (t) => console.log(`\n──── ${t}`);

const MKT = '0x' + 'ef'.repeat(32);
const TOK = 'tok-yes-attr';
const TOKN = 'tok-no-attr';

/**
 * Il ciclo VERO. Restituisce le spec arrivate a `placeOrder` e le righe d'audit.
 * `scopertoDaMin` guida il gradino della scala attraverso il registro della modalita' chiusura.
 */
async function giro({ carico = 0.54, size = 57.1, mid, bid, ask, scopertoDaMin, uscitaARiposo = null }) {
  const spec = []; const righe = [];
  const da = Date.now() - scopertoDaMin * 60_000;
  const ordini = uscitaARiposo === null ? [] : [{ orderId: 'USCITA', tokenId: TOK, side: 'SELL',
    price: uscitaARiposo, size, sizeRemaining: size, source: 'auto-close-on-fill' }];
  await runAutoCloseCycle({
    marketIds: [MKT],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, title: 'prova', tick: 0.01, minSize: 50, maxSpreadCents: 4.5,
      tokenId: TOK, tokenIdNo: TOKN,
      books: { yes: { tokenId: TOK, scoringMid: mid, bestBid: bid, bestAsk: ask },
        no: { tokenId: TOKN, scoringMid: +(1 - mid).toFixed(4), bestBid: +(1 - ask).toFixed(4), bestAsk: +(1 - bid).toFixed(4) } },
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true, bestBid: bid, bestAsk: ask }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK, size, avgPrice: carico, marketId: MKT }] }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    // ⚠ IL REGISTRO DELLA MODALITA' CHIUSURA E' CIO' CHE DA' IL GRADINO: senza, `urgenza` resta 0 e
    // nessun attraversamento sarebbe mai consentito — il test passerebbe per la ragione sbagliata.
    chiusura: { leggi: () => ({ attiva: true, daMin: scopertoDaMin }), entra: () => ({ nuova: false, voce: {} }) },
    placeOrder: async (s) => { spec.push(s); return { ok: true, orderId: 'o' + spec.length, sent: true }; },
    cancelOrder: async () => ({ ok: true }),
    audit: (r) => righe.push(r),
  });
  return { spec, righe, sell: spec.filter((s) => s.side === 'SELL') };
}

(async () => {
  sez('① IL CASO CONCESSO — gradino 2, prezzo sul pavimento, bid raggiungibile');
  {
    // Carico 54¢, scoperta da 150 min ⇒ gradino 2. Bid a 53¢: il pavimento è 53¢ (1 tick, e il 5% di
    // 54¢ è 2,7¢ quindi non morde). Il prezzo può scendere a 53¢ e lì colpisce il bid.
    // ⚠ SERVE UN'USCITA GIÀ A LIBRO, e la ragione va detta: l'inseguimento del bid vive nel ramo
    // `already-covered`/`uscita-da-abbassare`, cioè quando un'uscita esiste già e va riprezzata. Il
    // PRIMO piazzamento è una quotazione all'obiettivo e non insegue — è corretto, ma vuol dire che
    // l'attraversamento non può avvenire al primo giro. Senza questa riga il test misurerebbe il ramo
    // sbagliato e direbbe «non attraversa» per la ragione sbagliata.
    const g = await giro({ carico: 0.54, mid: 0.55, bid: 0.53, ask: 0.57, scopertoDaMin: 150,
      uscitaARiposo: 0.58 });
    const s = g.sell[0];
    ok('un ordine di vendita è stato mandato', !!s, `${g.sell.length} SELL`);
    // ⚠ L'ASSERZIONE CHE CONTA: il CAMPO SUL FILO, non il verdetto.
    ok('  ⚠ e dichiara `attraversaApposta` — il campo, non l\'intenzione', s && s.attraversaApposta === true,
      JSON.stringify({ attraversaApposta: s && s.attraversaApposta, inCoda: s && s.inCoda }));
    ok('  e NON dichiara `inCoda`: un ordine che attraversa non aspetta il suo turno',
      s && s.inCoda !== true);
    ok('  ed è dichiarato come chiusura, che è ciò che sblocca la deroga a valle',
      s && s.chiudePosizione === true);
    ok('  il prezzo colpisce il bid', s && s.price <= 0.53 + 1e-9, String(s && s.price));

    // ④ la dichiarazione a verbale
    const dich = g.righe.find((r) => r.outcome === 'attraversamento-consentito');
    ok('④ l\'attraversamento è a VERBALE', !!dich);
    ok('  con il gradino', dich && dich.observed.gradino === 2, String(dich && dich.observed.gradino));
    ok('  con il prezzo', dich && dich.observed.prezzo === s.price, String(dich && dich.observed.prezzo));
    ok('  con il bid colpito', dich && dich.observed.bidColpito === 0.53, String(dich && dich.observed.bidColpito));
    ok('  e con la perdita rispetto al carico, in centesimi',
      dich && dich.observed.perditaVsCaricoCents === -1 && dich.observed.inGuadagno === false,
      JSON.stringify(dich && { c: dich.observed.perditaVsCaricoCents, g: dich.observed.inGuadagno }));
  }

  sez('② GRADINO 0 — non si attraversa, e l\'ordine resta post-only');
  {
    // Stessa scena, ma scoperta da 5 minuti: la scala non ha concesso niente.
    const g = await giro({ carico: 0.54, mid: 0.55, bid: 0.53, ask: 0.57, scopertoDaMin: 5,
      uscitaARiposo: 0.58 });
    const s = g.sell[0];
    ok('l\'ordine parte comunque', !!s);
    ok('  ⚠ ma NON attraversa', !s || s.attraversaApposta !== true,
      JSON.stringify({ attraversaApposta: s && s.attraversaApposta }));
    ok('  e resta `inCoda`', s && s.inCoda === true);
    ok('  e non c\'è nessuna dichiarazione a verbale',
      !g.righe.some((r) => r.outcome === 'attraversamento-consentito'));
  }

  sez('③ SOTTO IL PAVIMENTO — la scala non concede l\'attraversamento');
  {
    // Bid a 48¢ contro un carico di 54¢: scendere lì costerebbe 6¢, la scala ne concede 1. Qui il
    // book è tenuto DENTRO la banda dell'uscita a riposo, così decide la scala e non il ramo fuori banda.
    const g = await giro({ carico: 0.54, mid: 0.505, bid: 0.48, ask: 0.53, scopertoDaMin: 150,
      uscitaARiposo: 0.53 });
    const s = g.sell[0];
    const dich = g.righe.find((r) => r.outcome === 'attraversamento-consentito');
    ok('  ⚠ il prezzo non scende sotto il pavimento', !s || s.price >= 0.53 - 1e-9,
      s ? `prezzo ${s.price} · pavimento 0.53 · bid 0.48` : 'nessun ordine');
    ok('  e se non incrocia non c\'è dichiarazione di attraversamento',
      !s || s.price > 0.48 ? !dich || dich.observed.tipo !== 'uscita' : true,
      dich ? String(dich.observed.tipo) : 'nessuna');
  }

  sez('③-bis ⚠ IL PERCORSO CHE PRECEDE I QUATTRO LIMITI: l\'uscita FUORI BANDA');
  {
    // ⚠ QUESTO BLOCCO DOCUMENTA UNA DIFFERENZA VERA, non un difetto trovato dal test.
    // Quando l'uscita a riposo esce dalla BANDA premiante, `close-at-market` chiude al bid e
    // `attraversaApposta` è CABLATO — da prima del permesso concesso oggi. Quel ramo non passa dai
    // limiti ② (gradino ≥ 1) e ③ (mai sotto il pavimento): qui vende a 48¢ su un carico di 54¢, cioè
    // −6¢, dove la scala ne concederebbe 1. È una regola preesistente e una decisione di rischio
    // dell'operatore — questo test la FISSA perché non cambi in silenzio, non la approva.
    const g = await giro({ carico: 0.54, mid: 0.50, bid: 0.48, ask: 0.52, scopertoDaMin: 150,
      uscitaARiposo: 0.56 });
    const s = g.sell[0];
    ok('attraversa, e il flag è cablato in quel ramo', s && s.attraversaApposta === true, String(s && s.price));
    ok('  ⚠ e vende SOTTO il pavimento della scala', s && s.price < 0.53, `${s && s.price} contro pavimento 0.53`);
    // ④ vale comunque: ogni attraversamento si dichiara.
    const dich = g.righe.find((r) => r.outcome === 'attraversamento-consentito');
    ok('④ ma la dichiarazione c\'è lo stesso', !!dich);
    ok('  e DICE che i limiti di gradino e pavimento non sono stati applicati',
      dich && dich.observed.limitiGradinoEPavimentoApplicati === false);
    ok('  con la perdita rispetto al carico', dich && dich.observed.perditaVsCaricoCents === -6,
      String(dich && dich.observed.perditaVsCaricoCents));
  }

  sez('④ ① IL LIMITE PIÙ IMPORTANTE — nessuna APERTURA di liquidità attraversa mai');
  {
    // ⚠ SI VERIFICA PER ASSENZA SU TUTTE LE SPEC, non solo sulle SELL: se un giorno qualcuno passasse
    // il flag a una gamba di liquidità, questa riga lo prenderebbe. È il limite che protegge il
    // capitale, e la sua prova non deve dipendere da quale ramo l'ha prodotto.
    const g = await giro({ carico: 0.54, mid: 0.55, bid: 0.53, ask: 0.57, scopertoDaMin: 150,
      uscitaARiposo: 0.58 });
    const aperture = g.spec.filter((s) => s.side === 'BUY');
    ok('nessun BUY dichiara `attraversaApposta` senza essere un completamento di coppia',
      aperture.every((s) => s.attraversaApposta !== true || s.completaCoppia === true),
      `${aperture.length} BUY esaminati`);
    // E la prova strutturale sul modulo: il tipo 'liquidita' non ottiene mai il permesso.
    ok('  e il modulo rifiuta il tipo «liquidita» per costruzione',
      valutaAttraversamento({ tipo: 'liquidita', gradino: 3, prezzo: 0.53, pavimento: 0.50, bid: 0.53 }).attraversa === false);
  }

  sez('⑤ IL PREZZO SOPRA IL BID NON CHIEDE IL PERMESSO');
  {
    // Il mercato è salito e l'uscita a riposo è DENTRO la banda: decide la scala, il prezzo resta
    // sopra il bid, quindi non incrocia e non serve nessuna deroga.
    const g = await giro({ carico: 0.54, mid: 0.60, bid: 0.50, ask: 0.62, scopertoDaMin: 150,
      uscitaARiposo: 0.60 });
    const s = g.sell[0];
    ok('l\'ordine non attraversa perché non incrocia', !s || s.attraversaApposta !== true,
      s ? `prezzo ${s.price} · bid 0.50` : 'nessun ordine');
    ok('  e resta una quotazione in coda', !s || s.inCoda === true);
  }

  console.log(`\n${pass} asserzioni verdi, ${fail} rosse`);
  process.exit(fail === 0 ? 0 : 1);
})();

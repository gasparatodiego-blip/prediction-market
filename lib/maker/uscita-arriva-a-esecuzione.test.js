'use strict';
// lib/maker/uscita-arriva-a-esecuzione.test.js — IL TEST CHE IERI SAREBBE STATO ROSSO.
//
// ═══ PERCHE' ESISTE, E PERCHE' NON BASTAVA «LA SCALA SCENDE» ═════════════════════════════════════════
// Il 16 agosto il bot ha mandato al venue **146 ordini SELL** su FL-02 in 2h36m, uno ogni due minuti,
// e **nessuno e' mai stato eseguito**: la gamba NO parcheggiata a 51¢ con il bid a ~47¢, la YES a 56¢
// con il bid a ~52¢. Sempre 4-5¢ SOPRA il bid, `post-only`, ripiazzati allo stesso prezzo per due ore
// e mezza. Non erano uscite: erano quotazioni maker con l'etichetta «uscita».
//
// La causa e' che il prezzo d'uscita e' vincolato a restare dentro la BANDA PREMIANTE, e il bordo
// basso della banda stava sopra il bid. Una quota che deve maturare premi non puo' attraversare lo
// spread — e un ordine che non attraversa si esegue solo se il mercato viene a prenderlo.
// L'unica vendita eseguita in tutta la giornata e' stata quella dichiarata `cross-dichiarato`, cioe'
// quella in cui una mano umana ha detto «attraversa».
//
// ⚠ QUINDI LA DOMANDA DEL TEST NON E' «la scala ha concesso un prezzo piu' basso?» ma **«il prezzo che
// l'uscita produce e' un prezzo a cui qualcuno ci prende?»**. Un test sulla concessione sarebbe stato
// verde tutte e 146 le volte.
//
// LE TRE PROPRIETA' CHE SI DIFENDONO QUI:
//   ① l'uscita INSEGUE il BID — non l'ask. Fino al 17 agosto 2026 mirava all'ask, che per una vendita
//      e' il lato sbagliato del libro: e' la causa diretta dei 146 ordini mai eseguiti;
//   ② se il pavimento della scala lo consente, l'uscita arriva AL BID, cioe' a un prezzo eseguibile;
//   ③ il pavimento resta un pavimento: quando il bid sta sotto, l'uscita si ferma e NON e' colpibile —
//      ed e' la risposta giusta, non un difetto.
//
// ⚠ RESTA APERTA LA META' CHE QUESTO TEST NON PUO' CHIUDERE: al prezzo del bid un SELL `post-only`
// INCROCIA, e il venue lo rifiuta (`invalid post-only order: order crosses book`, visto il 16 agosto).
// Rendere il prezzo giusto non basta a renderlo eseguibile: serve il permesso di attraversare, che
// oggi ha solo la corsia manuale (`cross-dichiarato`). E' una decisione di rischio dell'operatore.
//
// ⚠ NON si prova che il venue esegua — questo e' un test, non un mercato. Si prova che il prezzo
// prodotto sia **colpibile**, cioe' `prezzo <= bid`. E' l'unica meta' della domanda che il codice
// controlla; l'altra meta' e' il mercato, e la si guarda dal vivo.
//
// Run: node lib/maker/uscita-arriva-a-esecuzione.test.js

const { decideClose } = require('./auto-close');
const { livelloUrgenza } = require('./urgenza-scoperto');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const sez = (t) => console.log(`\n──── ${t}`);
const c = (p) => (typeof p === 'number' ? `${(p * 100).toFixed(1)}¢` : String(p));

const TOK = 'tok-yes';
const TOKN = 'tok-no';

/** Le regole di un mercato con banda ±4,5¢ e tick 1¢, come FL-02. */
const regole = (mid, bid, ask) => ({
  readable: true, title: 'prova', tick: 0.01, minSize: 50, maxSpreadCents: 4.5,
  tokenId: TOK, tokenIdNo: TOKN,
  books: { yes: { tokenId: TOK, scoringMid: mid, bestBid: bid, bestAsk: ask },
    no: { tokenId: TOKN, scoringMid: +(1 - mid).toFixed(4), bestBid: +(1 - ask).toFixed(4), bestAsk: +(1 - bid).toFixed(4) } },
});

/** Un'uscita gia' a riposo al prezzo `px`: e' la situazione del 16 agosto. */
const uscitaARiposo = (px, size) => ([{ orderId: 'USCITA', tokenId: TOK, side: 'SELL',
  price: px, size, sizeRemaining: size, source: 'auto-close-on-fill' }]);

// ⚠ IL PAVIMENTO SI DERIVA DALLA COSTANTE VERA, NON SI RICOPIA (R7, 18 agosto 2026). Prima questo
// file cablava `0.53` e `Math.min(0.01, carico*0.05)`, cioè una COPIA della regola: quando la regola
// è cambiata il test è diventato rosso pur essendo il codice corretto — il reperto D1 su un test.
const { PERDITA_MAX_FRAZIONE } = require('./urgenza-scoperto');
const PAV = (carico) => +(carico * (1 - PERDITA_MAX_FRAZIONE)).toFixed(10);

function giudizio({ carico, size = 57.1, mid, bid, ask, minuti, restingOrders = [] }) {
  return decideClose({
    position: { tokenId: TOK, size, avgPrice: carico },
    restingOrders, rules: regole(mid, bid, ask), book: 'yes',
    venue: { readable: true, closed: false, acceptingOrders: true, bestBid: bid, bestAsk: ask },
    urgenza: livelloUrgenza({ scopertoDaMin: minuti }),
  });
}

(async () => {
  sez('① LA SITUAZIONE ESATTA DEL 16 AGOSTO — uscita a 56¢ con il bid a 52¢');
  {
    // FL-02, gamba YES: carico 0,54, uscita a riposo a 56¢, book 52/56. Per 146 ordini.
    const d = giudizio({ carico: 0.54, mid: 0.54, bid: 0.52, ask: 0.56, minuti: 150,
      restingOrders: uscitaARiposo(0.56, 57.1) });
    ok('la decisione NON è «già coperta, non faccio niente»', d.action !== 'already-covered',
      `${d.action}${d.gate ? ' · ' + d.gate : ''}`);
    ok('  è un riprezzo verso il basso', d.gate === 'uscita-da-abbassare', String(d.gate));
    ok('  e il prezzo nuovo è PIÙ BASSO di quello a libro', d.price < 0.56, `${c(d.price)} contro ${c(0.56)}`);
    // ⚠ QUI IL BOOK BATTE IL PAVIMENTO, E DA R7 È CAMBIATO IL VERSO. Carico 54¢, gradino 2: il 5%
    // vale 2,7¢, quindi il pavimento è 51,3¢. Il bid sta a 52¢, cioè SOPRA il pavimento: l'uscita ci
    // arriva ed è colpibile. La scala dice quanto si può perdere, il book dove si viene presi, e
    // vince il più stretto — qui il più stretto è il book.
    // ⚠ COL CODICE DI IERI questa asserzione dava 53¢ e l'uscita NON era colpibile: la concessione
    // era `min(1 tick, 5%)` e un tick da 1¢ si fermava un centesimo sopra il bid. È esattamente la
    // differenza che R7 chiede, e questo blocco è il posto dove si vede.
    ok('  arriva al BID, perché il pavimento del 5% sta sotto', Math.abs(d.price - 0.52) < 1e-9,
      `${c(d.price)} · pavimento ${c(PAV(0.54))} · bid ${c(0.52)}`);
    ok('  ⚠ e resta comunque sopra il pavimento: il book non lo sfonda', d.price >= PAV(0.54) - 1e-9,
      `${c(d.price)} ≥ ${c(PAV(0.54))}`);
  }

  sez('①-bis ANCHE L\'USCITA CHE NASCE INSEGUE IL BID — dal 17 agosto 2026');
  {
    // ⚠ SENZA USCITA A RIPOSO: è il PRIMO piazzamento, il ramo che fino a oggi non inseguiva.
    // Il 16 agosto ogni uscita nasceva all'obiettivo, sopra il bid, e diventava colpibile solo se
    // sopravviveva a un ciclo E il ramo `already-covered` la riprendeva: 146 SELL, zero eseguiti.
    const d = giudizio({ carico: 0.54, mid: 0.53, bid: 0.53, ask: 0.55, minuti: 150, restingOrders: [] });
    ok('il verdetto è una chiusura', d.action === 'close' || d.action === 'close-at-market', String(d.action));
    ok('  ⚠ e il prezzo è COLPIBILE già al primo piazzamento', d.price != null && d.price <= 0.53 + 1e-9,
      `${c(d.price)} contro bid ${c(0.53)}`);
    ok('  e resta sopra il pavimento della scala', d.price >= PAV(0.54) - 1e-9, `pavimento ${c(PAV(0.54))}`);
    ok('  il fatto è dichiarato nel verdetto', d.inseguitoIlBid === true || d.action === 'close-at-market',
      JSON.stringify({ inseguito: d.inseguitoIlBid, bid: d.bidInseguito }));
  }

  sez('①-ter E AL GRADINO 0 NON INSEGUE NEMMENO AL PRIMO PIAZZAMENTO');
  {
    // La cintura che impedisce all'inseguimento di diventare una svendita: senza concessione della
    // scala l'uscita resta all'obiettivo, anche se il bid sta più in basso.
    const d = giudizio({ carico: 0.54, mid: 0.53, bid: 0.53, ask: 0.55, minuti: 5, restingOrders: [] });
    ok('a 5 minuti il prezzo NON è stato abbassato al bid', d.price > 0.53, c(d.price));
    ok('  e non dichiara nessun inseguimento', d.inseguitoIlBid !== true);
  }

  sez('② IL GRADINO 0 NON INSEGUE, ed è giusto');
  {
    // ⚠ SI ABBASSA COMUNQUE, ma solo fino all'OBIETTIVO ordinario — carico + 1% = 55¢ — non fino al
    // carico. È corretto e va distinto: `uscita-da-abbassare` riporta l'ordine sul bersaglio giusto a
    // qualunque gradino; è la CONCESSIONE (scendere sotto l'obiettivo, fino al carico e oltre) che
    // richiede il gradino 1. Un test che pretendesse «a 5 minuti non si tocca niente» difenderebbe una
    // regola che non esiste.
    const d = giudizio({ carico: 0.54, mid: 0.54, bid: 0.52, ask: 0.56, minuti: 5,
      restingOrders: uscitaARiposo(0.56, 57.1) });
    ok('a 5 minuti si riprezza solo fino all\'obiettivo, non fino al carico',
      Math.abs(d.price - 0.55) < 1e-9, `${c(d.price)} = carico ${c(0.54)} + 1%`);
    ok('  e NON scende al carico: la concessione arriva col gradino 1', d.price > 0.54);
  }

  sez('③ C\'È UNA TERZA VIA CHE ATTRAVERSA DAVVERO: l\'uscita FUORI BANDA si chiude a mercato');
  {
    // ⚠ QUESTO BLOCCO DOCUMENTA UN PERCORSO CHE NON AVEVO CONTATO, e che il test ha trovato.
    // Quando il book si sposta tanto da lasciare l'uscita a riposo FUORI dalla banda premiante, non è
    // più una domanda di gradini: quell'ordine non matura nulla e non ha motivo di restare lì. Il ramo
    // `close-at-market` chiude la posizione AL BID, e lo fa a prescindere dal pavimento dell'urgenza —
    // perché è una decisione diversa («questo ordine è morto»), non una concessione della scala.
    // È l'unica strada per cui oggi un'uscita del bot può arrivare a un prezzo eseguibile senza che
    // qualcuno dichiari a mano di voler attraversare.
    const d = giudizio({ carico: 0.54, mid: 0.42, bid: 0.40, ask: 0.44, minuti: 90,
      restingOrders: uscitaARiposo(0.56, 57.1) });
    ok('il verdetto è la chiusura a mercato, non un riprezzo', d.action === 'close-at-market', String(d.action));
    ok('  e il prezzo È il bid: colpibile', Math.abs(d.price - 0.40) < 1e-9, c(d.price));
    ok('  il motivo nomina l\'uscita dalla banda',
      /USCITA dalla banda premiante/.test(String(d.reason || '')), String(d.reason || '').slice(0, 70));
  }

  sez('④ QUANDO IL BOOK È SOPRA IL CARICO, L\'USCITA DEVE ARRIVARE AL BID');
  {
    // Il caso favorevole: il mercato è salito, il bid (56¢) sta sopra il carico (54¢). Qui non c'è
    // nessuna ragione per restare appesi: si scende fino al bid e si viene presi.
    const d = giudizio({ carico: 0.54, mid: 0.57, bid: 0.56, ask: 0.58, minuti: 45,
      restingOrders: uscitaARiposo(0.62, 57.1) });
    ok('si riprezza', d.gate === 'uscita-da-abbassare' || d.action === 'close-at-market',
      `${d.action} · ${d.gate}`);
    ok('  ⚠ e il prezzo è COLPIBILE: ≤ bid', d.price != null && d.price <= 0.56 + 1e-9,
      `${c(d.price)} contro bid ${c(0.56)}`);
    ok('  e resta sopra il carico: non si regala niente', d.price >= 0.54 - 1e-9, c(d.price));
  }

  sez('⑤ IL CONTO CHE IERI SAREBBE STATO ROSSO — 146 ordini, zero colpibili');
  {
    // Si rigioca la giornata di FL-02 sulla gamba NO: carico 0,47, book che oscilla fra 46 e 48,
    // uscita a riposo a 51¢. Si conta quante volte il prezzo prodotto sarebbe stato colpibile.
    let colpibili = 0; let totale = 0; let appesi = 0;
    for (let m = 0; m <= 160; m += 2) {
      for (const bid of [0.46, 0.47, 0.48]) {
        totale++;
        const d = giudizio({ carico: 0.47, mid: bid + 0.02, bid, ask: bid + 0.04, minuti: m,
          restingOrders: uscitaARiposo(0.51, 57.1) });
        if (d.price == null) { appesi++; continue; }
        if (d.price <= bid + 1e-9) colpibili++; else appesi++;
      }
    }
    console.log(`    ${totale} istanti simulati · ${colpibili} colpibili · ${appesi} appesi sopra il book`);
    // ⚠ NON si pretende il 100%: sotto i 30 minuti la scala non deve concedere niente, e con un bid
    // sotto il pavimento la risposta giusta è restare. Si pretende che NON sia ZERO — che è il numero
    // vero del 16 agosto, su 146 ordini.
    ok('almeno un istante produce un prezzo colpibile', colpibili > 0,
      `${colpibili} su ${totale} — il 16 agosto furono 0 su 146`);
    ok('  e la quota di colpibili è sostanziale, non un caso limite', colpibili / totale > 0.25,
      `${(100 * colpibili / totale).toFixed(1)}%`);
  }

  sez('⑥ FINCHÉ L\'USCITA RESTA IN BANDA, IL PAVIMENTO COMANDA — anche al gradino 3');
  {
    // Il complemento del blocco ③: qui l'uscita a riposo è DENTRO la banda, quindi non scatta la
    // chiusura a mercato e decide la scala. Al gradino 3, con il book 4¢ sotto il carico, il prezzo
    // non scende sotto il pavimento — cioè il bot non svende da solo neanche dopo quattro ore.
    const d = giudizio({ carico: 0.54, mid: 0.52, bid: 0.50, ask: 0.54, minuti: 300,
      restingOrders: uscitaARiposo(0.55, 57.1) });
    const pavimento = PAV(0.54);
    ok('il prezzo non scende sotto il pavimento', d.price == null || d.price >= pavimento - 1e-9,
      d.price == null ? 'nessun prezzo' : `${c(d.price)} · pavimento ${c(pavimento)}`);
    ok('  e la posizione resta aperta invece di essere svenduta', d.price == null || d.price > 0.50,
      'il bid è a 50¢: venderci costerebbe 4¢ contro 1 concesso');
  }

  console.log(`\n${pass} asserzioni verdi, ${fail} rosse`);
  process.exit(fail === 0 ? 0 : 1);
})();

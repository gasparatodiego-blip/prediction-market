'use strict';
// lib/maker/nostri-ordini.js — QUALI ORDINI SONO NOSTRI SU QUESTO LATO, E COME SI UNISCONO DUE LISTE.
//
// ═══ IL DIFETTO CHE CHIUDE ═══════════════════════════════════════════════════════════════════════════
// «Mai primo sul libro» e ogni decisione di posizionamento si calcolano sul book ALTRUI, cioè sul book
// meno i nostri ordini. La sottrazione vera è una sola e sta in `top-of-book.othersLadder` — quella non
// è mai stata duplicata. Ma la SELEZIONE, cioè «quali righe sono nostre su questo lato», viveva scritta
// a mano in due punti diversi:
//
//   · il percorso di DECISIONE (`auto-reprice`)   → `owned.filter((x) => x.book === order.book)`
//   · il percorso di PIAZZAMENTO (`manual-order`) → un filtro per `tokenId` con una sua normalizzazione
//
// Due filtri scritti a mano sullo stesso concetto sono esattamente il reperto che il rilevatore D1
// dell'audit cerca, e qui la divergenza non produce un errore visibile: produce un book altrui diverso
// fra chi DECIDE il prezzo e chi lo PIAZZA, cioè due risposte a «chi è il miglior concorrente».
//
// Adesso la selezione è una funzione sola, chiamata da entrambi. Nessuna delle due chiamate cambia
// comportamento su un ingresso ben formato: cambia che non possono più divergere.
//
// ═══ E L'ALTRA METÀ: IL PANNELLO NON MANDAVA NIENTE ══════════════════════════════════════════════════
// Il pannello chiedeva un piazzamento senza dichiarare i propri ordini a riposo. `placeManualOrder` li
// leggeva dal venue per conto suo (correzione già in servizio), ma quella lettura è una chiamata di
// rete che può fallire — e quando fallisce si prosegue con la lista VUOTA, cioè con il book intero
// scambiato per concorrenza. Dal secondo ordine sullo stesso mercato il sistema si accodava a se stesso,
// un tick per volta, fino al bordo della banda.
//
// La cura non è «fidarsi del client»: è `unisci`. Il pannello manda ciò che ha già in mano (lo stesso
// elenco che mostra a schermo), il server ricostruisce comunque la sua lista, e le due si UNISCONO
// deduplicando per `orderId`. Il client può solo AGGIUNGERE righe a ciò che il server ha già trovato —
// non può toglierne, e non può far passare per «non nostro» un ordine che il server sa essere nostro.
// Un ordine di troppo nella lista rende il calcolo più prudente (ci si accoda più indietro); un ordine
// mancante lo rende sbagliato nella direzione che fa male. L'unione sbaglia solo dalla parte giusta.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// `Number(null)` è 0 e `Number('')` è 0: un campo vuoto non deve potersi travestire da prezzo o da size.
const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));

/**
 * NORMALIZZA UNA RIGA in ciò che `othersLadder` sa consumare: `{orderId, price, size}`.
 * `sizeRemaining` vince su `size` quando c'è: un ordine riempito a metà occupa il book per il residuo.
 * Una riga che non si legge NON diventa una riga con zero: sparisce, e chi chiama la conta.
 */
function normalizza(o) {
  if (!o || typeof o !== 'object') return null;
  const p = num(o.price);
  const szR = num(o.sizeRemaining);
  const sz = fin(szR) && szR > 0 ? szR : num(o.size);
  if (!fin(p) || !fin(sz) || sz <= 0) return null;
  return { orderId: o.orderId != null ? String(o.orderId) : null, price: p, size: sz };
}

/**
 * I NOSTRI ORDINI SUL LATO CHE SI STA QUOTANDO. Pura.
 *
 * Il lato si identifica per `tokenId` quando c'è — è un fatto del venue e non un'etichetta — e per
 * `book` altrimenti. Si accettano entrambi perché i due percorsi hanno in mano cose diverse:
 * `manual-order` conosce i token id dalle regole del mercato, `auto-reprice` ragiona per book.
 *
 * ⚠ NON SI FILTRA PER `side`, ed è deliberato: sul lato bid di un book stanno i nostri BUY, e la
 * proiezione dei SELL la fa `prezzo-in-coda` specchiando i prezzi. Filtrare qui per lato toglierebbe
 * righe che quella proiezione si aspetta di trovare.
 *
 * @returns {{ordini:Array<{orderId,price,size}>, scartate:number, motivo:string|null}}
 */
function nostriSulLato({ orders = null, tokenId = null, book = null } = {}) {
  if (!Array.isArray(orders)) {
    return { ordini: [], scartate: 0, motivo: 'nessuna lista di ordini propri: la coda si calcola senza sottrarli' };
  }
  const tok = tokenId != null && String(tokenId) ? String(tokenId) : null;
  const bk = typeof book === 'string' && book ? book.toLowerCase() : null;
  const ordini = []; let scartate = 0;
  for (const o of orders) {
    if (!o) { scartate += 1; continue; }
    // ── UNA RIGA SENZA ETICHETTA È GIÀ STATA SELEZIONATA DA CHI LA MANDA ──────────────────────────
    // I chiamanti in-process passano liste GIÀ ristrette al lato che stanno quotando, e quelle righe
    // portano prezzo e size ma non sempre `tokenId`/`book`. Scartarle qui le toglierebbe dalla
    // sottrazione — cioè le lascerebbe nel book altrui travestite da concorrenti, che è esattamente il
    // difetto che questo modulo esiste per chiudere.
    // Una riga ETICHETTATA che non corrisponde si scarta invece eccome: quella è un'informazione, e
    // dice che appartiene a un altro lato.
    const suoTok = o.tokenId != null && String(o.tokenId) ? String(o.tokenId) : null;
    const suoBook = typeof o.book === 'string' && o.book ? o.book.toLowerCase() : null;
    const appartiene = (suoTok === null && suoBook === null)
      ? true
      : (suoTok !== null && tok ? suoTok === tok
        : (suoBook !== null && bk ? suoBook === bk
          // Etichettata su un asse che il chiamante non ha indicato: non si può contraddire, si tiene.
          : true));
    if (!appartiene) continue;
    const n = normalizza(o);
    if (!n) { scartate += 1; continue; }
    ordini.push(n);
  }
  return { ordini, scartate, motivo: null };
}

/**
 * UNISCE DUE LISTE DI ORDINI PROPRI, deduplicando per `orderId`.
 *
 * ═══ LA REGOLA DI PRECEDENZA, E PERCHÉ È QUESTA ═════════════════════════════════════════════════════
 * A parità di `orderId` vince la riga del PRIMO argomento, che i chiamanti passano come «quella del
 * server». Il server legge dal venue; il client mostra ciò che ha in cache. Se dicono due prezzi
 * diversi per lo stesso ordine, quello del venue è il fatto.
 *
 * ═══ UNA RIGA SENZA `orderId` NON SI DEDUPLICA, E SI TIENE ══════════════════════════════════════════
 * Scartarla la toglierebbe dalla sottrazione, cioè la lascerebbe dentro il book altrui travestita da
 * concorrente — il difetto che questo modulo esiste per chiudere. Si tiene, al costo di poterla contare
 * due volte: contare due volte un nostro ordine rende il calcolo più PRUDENTE (ci si accoda più
 * indietro), non più permissivo.
 */
function unisci(primaria, secondaria) {
  const out = []; const visti = new Set();
  let duplicati = 0; let dalClient = 0;
  const aggiungi = (lista, marcaClient) => {
    for (const o of Array.isArray(lista) ? lista : []) {
      const n = normalizza(o);
      if (!n) continue;
      if (n.orderId) {
        if (visti.has(n.orderId)) { duplicati += 1; continue; }
        visti.add(n.orderId);
      }
      out.push(n);
      if (marcaClient) dalClient += 1;
    }
  };
  aggiungi(primaria, false);
  aggiungi(secondaria, true);
  return { ordini: out, duplicati, aggiuntiDalClient: dalClient };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ nostri-ordini ════');

  const righe = [
    { orderId: 'a', tokenId: 'T1', book: 'yes', side: 'BUY', price: 0.40, size: 100 },
    { orderId: 'b', tokenId: 'T1', book: 'yes', side: 'SELL', price: 0.55, sizeRemaining: 30, size: 100 },
    { orderId: 'c', tokenId: 'T2', book: 'no', side: 'BUY', price: 0.55, size: 50 },
  ];
  const perToken = nostriSulLato({ orders: righe, tokenId: 'T1' });
  ok('selezione per tokenId: due righe su tre', perToken.ordini.length === 2);
  ok('  e `sizeRemaining` vince su `size`', perToken.ordini[1].size === 30);
  const perBook = nostriSulLato({ orders: righe, book: 'YES' });
  ok('selezione per book: stesse due righe, e il case non conta', perBook.ordini.length === 2);
  ok('  i due percorsi danno lo STESSO insieme',
    JSON.stringify(perToken.ordini) === JSON.stringify(perBook.ordini));
  ok('lista assente ⇒ vuota con motivo, non un errore',
    nostriSulLato({ orders: null }).ordini.length === 0 && !!nostriSulLato({ orders: null }).motivo);
  ok('una riga illeggibile sparisce e viene CONTATA',
    nostriSulLato({ orders: [{ orderId: 'x', tokenId: 'T1', price: null, size: 10 }], tokenId: 'T1' }).scartate === 1);
  ok('  e size zero non è una size', nostriSulLato({ orders: [{ tokenId: 'T1', price: 0.4, size: 0 }], tokenId: 'T1' }).ordini.length === 0);
  ok('né tokenId né book chiesti ⇒ le righe ETICHETTATE restano tali e si tengono tutte',
    nostriSulLato({ orders: righe }).ordini.length === 3);
  // ⚠ LA REGOLA CHE CONTA: una riga SENZA etichetta è già stata selezionata da chi la manda, quindi si
  // tiene; una riga etichettata su un ALTRO lato si scarta. Scartare le prime le lascerebbe nel book
  // altrui travestite da concorrenti — il difetto che questo modulo esiste per chiudere.
  ok('riga senza etichetta ⇒ si tiene (il chiamante l\'ha già selezionata)',
    nostriSulLato({ orders: [{ orderId: 'n', price: 0.4, size: 10 }], tokenId: 'T1' }).ordini.length === 1);
  ok('riga etichettata su un ALTRO token ⇒ si scarta',
    nostriSulLato({ orders: [{ orderId: 'n', tokenId: 'T9', price: 0.4, size: 10 }], tokenId: 'T1' }).ordini.length === 0);
  ok('  e su un altro book idem',
    nostriSulLato({ orders: [{ orderId: 'n', book: 'no', price: 0.4, size: 10 }], book: 'yes' }).ordini.length === 0);

  const srv = [{ orderId: 'a', price: 0.40, size: 100 }];
  const cli = [{ orderId: 'a', price: 0.99, size: 1 }, { orderId: 'z', price: 0.41, size: 20 }];
  const u = unisci(srv, cli);
  ok('unione: due ordini distinti', u.ordini.length === 2);
  ok('  il duplicato è contato', u.duplicati === 1);
  ok('  e a parità di id VINCE il server (il venue è il fatto)', u.ordini[0].price === 0.40);
  ok('  il client può solo AGGIUNGERE', u.aggiuntiDalClient === 1 && u.ordini[1].orderId === 'z');
  const senzaId = unisci([{ price: 0.4, size: 10 }], [{ price: 0.4, size: 10 }]);
  ok('una riga senza orderId si tiene (contarla due volte è il verso prudente)', senzaId.ordini.length === 2);
  ok('client vuoto/assente non toglie niente al server',
    unisci(srv, null).ordini.length === 1 && unisci(srv, []).ordini.length === 1);
  ok('server vuoto: il client passa comunque', unisci([], cli).ordini.length === 2);

  console.log(`\nnostri-ordini: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { nostriSulLato, unisci, normalizza, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

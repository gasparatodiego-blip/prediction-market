'use strict';
// lib/maker/scadenza-fuori-perimetro.js — UN MERCATO CHE SCADE ESCE DAL PERIMETRO DA SOLO.
//
// ═══ IL DIFETTO CHE QUESTO MODULO CHIUDE (17 agosto 2026, deciso dall'operatore) ═════════════════════
// Il perimetro live-min e' `abilitati ∪ mercati con posizione` (§4.8). Chi toglieva un mercato scaduto
// dagli ABILITATI erano due percorsi, e nessuno dei due basta:
//   · la SELEZIONE automatica, che esclude sotto le 24 h — ma solo quando e' ACCESA, e oggi e' spenta;
//   · il ciclo da 6 ORE, che al piu' lo esclude dal PIANO: sei ore sono la cadenza sbagliata per una
//     scadenza, e il perno del giro controllato scade fra ~28 h.
// Quindi, a selezione spenta, un mercato scaduto restava nel perimetro finche' qualcuno non lo toglieva a
// mano. Un perimetro che contiene un mercato che non accetta piu' ordini non e' un perimetro sbagliato di
// poco: e' capitale autorizzato su un mercato che sta risolvendo.
//
// ═══ LE TRE CONDIZIONI, E PERCHE' SONO TRE ══════════════════════════════════════════════════════════
// Si rilascia un mercato solo se TUTTE E TRE valgono, e ognuna evita un danno diverso:
//   ① la vita residua e' sotto il pavimento d'orizzonte (o il mercato e' chiuso). La soglia NON e' un
//      numero nuovo: e' `MIN_HORIZON_DAYS` importato da `lib/rewards/horizon`, cioe' la stessa che il
//      pianificatore usa per non SCEGLIERE un mercato. Sotto quella soglia il piano non lo prenderebbe
//      comunque: tenerlo nel perimetro autorizza senza servire;
//   ② NESSUNA POSIZIONE APERTA. §4.13 lo dice per un'altra ragione e vale identica qui: togliere dal
//      riprezzo un mercato con una gamba viva la fa morire di GTD in ≤ 23 minuti, cioe' PRIMA dei 30
//      minuti che la scala d'uscita le concede. Un rilascio che accorcia la via d'uscita e' un danno;
//   ③ NESSUN ORDINE VIVO. Stesso argomento: un ordine a riposo su un mercato appena rilasciato non
//      viene piu' rinnovato e muore per scadenza GTD.
//
// ⚠ FAIL-CLOSED IN TUTTE LE DIREZIONI, e sono tre letture diverse: scadenza non determinabile ⇒ NON si
// rilascia (è l'opposto di §4.4, dove una scadenza ignota ESCLUDE dal piano — ed è giusto che le due
// direzioni siano opposte: lì l'ignoranza impedisce di aprire, qui impedirebbe di gestire); posizioni non
// leggibili ⇒ non si rilascia niente; ordini vivi non leggibili ⇒ non si rilascia niente. Un rilascio
// deciso al buio toglie la gestione a capitale che non abbiamo potuto vedere.
//
// ⚠ E NON ACCENDE NIENTE. Spegne l'INGRESSO e nient'altro: la decisione qui e' un elenco di mercati da
// rilasciare, e chi la esegue riusa `rilasciaDallaSelezione` — che tocca `setAutoReprice` e niente altro
// (non l'uscita automatica, non il tracking, nessuna cancellazione). Un rilascio che spegnesse anche la
// via d'uscita ripeterebbe §5-bis p.44.
//
// Puro: nessun `require` di stato, nessun I/O. Scadenze, posizioni e ordini arrivano gia' letti.

const { MIN_HORIZON_DAYS } = require('../rewards/horizon');

/** Il pavimento in ORE, DERIVATO dall'orizzonte del pianificatore: nessuna costante nuova. */
const ORE_MINIME = MIN_HORIZON_DAYS * 24;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * @param {{
 *   abilitati:string[],                        i mercati oggi nella allowlist
 *   scadenzaMs:(id:string)=>(number|null),     la scadenza riconciliata, o null se non determinabile
 *   chiuso?:(id:string)=>(boolean|null),       il venue dice che non accetta piu' ordini (null = non letto)
 *   conPosizione:(string[]|null),              i mercati con posizione aperta — null = NON LEGGIBILI
 *   conOrdiniVivi:(string[]|null),             i mercati con ordini a riposo — null = NON LEGGIBILI
 *   ora:number,
 *   oreMinime?:number
 * }} a
 * @returns {{daRilasciare:Array, tenuti:Array, motivo:(string|null), oreMinime:number}}
 */
function valutaScadenze({ abilitati, scadenzaMs, chiuso, conPosizione, conOrdiniVivi, ora, oreMinime } = {}) {
  const soglia = fin(oreMinime) && oreMinime > 0 ? oreMinime : ORE_MINIME;
  const out = { daRilasciare: [], tenuti: [], motivo: null, oreMinime: soglia };

  if (!Array.isArray(abilitati) || !fin(ora)) {
    out.motivo = 'allowlist od orologio non leggibili: nessun rilascio';
    return out;
  }
  // ⚠ `null` NON E' UNA LISTA VUOTA. Una lettura fallita delle posizioni interpretata come «nessuna
  // posizione» farebbe rilasciare esattamente i mercati che stanno gestendo del capitale.
  if (!Array.isArray(conPosizione) || !Array.isArray(conOrdiniVivi)) {
    out.motivo = 'posizioni o ordini a riposo non leggibili: nessun rilascio (una lettura mancante non e\' un mercato vuoto)';
    return out;
  }
  const conPos = new Set(conPosizione.map(norm));
  const conOrd = new Set(conOrdiniVivi.map(norm));

  for (const grezzo of abilitati) {
    const id = norm(grezzo);
    if (!id) continue;
    const scad = typeof scadenzaMs === 'function' ? scadenzaMs(id) : null;
    const chiusoOra = typeof chiuso === 'function' ? chiuso(id) : null;
    const oreResidue = fin(scad) ? (scad - ora) / 3_600_000 : null;

    // ① scaduto, chiuso, o sotto il pavimento d'orizzonte
    const scadutoDavvero = chiusoOra === true || (fin(oreResidue) && oreResidue <= soglia);
    if (!scadutoDavvero) {
      out.tenuti.push({ id, oreResidue: fin(oreResidue) ? +oreResidue.toFixed(2) : null,
        motivo: fin(oreResidue) ? `vita residua ${oreResidue.toFixed(1)} h, sopra il pavimento di ${soglia} h`
          : 'scadenza non determinabile: NON si rilascia (una scadenza che non si legge non e\' una scadenza passata)' });
      continue;
    }
    // ②③ non si tocca un mercato che sta gestendo qualcosa
    if (conPos.has(id) || conOrd.has(id)) {
      out.tenuti.push({ id, oreResidue: fin(oreResidue) ? +oreResidue.toFixed(2) : null,
        motivo: `scaduto (${chiusoOra === true ? 'chiuso al venue' : `${oreResidue.toFixed(1)} h`}) ma `
          + `${conPos.has(id) ? 'ha una posizione aperta' : 'ha ordini a riposo'}: resta abilitato al riprezzo, `
          + 'o la gamba muore di GTD in 23 minuti invece dei 30 che la scala d\'uscita le concede' });
      continue;
    }
    out.daRilasciare.push({ id, oreResidue: fin(oreResidue) ? +oreResidue.toFixed(2) : null,
      chiusoAlVenue: chiusoOra === true,
      motivo: chiusoOra === true
        ? 'il venue non accetta piu\' ordini su questo mercato, e non c\'e\' niente da gestire: esce dal perimetro'
        : `vita residua ${oreResidue.toFixed(1)} h sotto il pavimento di ${soglia} h, nessuna posizione e nessun ordine: esce dal perimetro` });
  }
  return out;
}

module.exports = { valutaScadenze, ORE_MINIME };

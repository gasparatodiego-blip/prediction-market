'use strict';
// lib/maker/min-size-mercato.js — IL MINIMO PREMIANTE DEL VENUE, ANCHE QUANDO IL MERCATO E' USCITO DAL
// BOARD. La decisione e' PURA (nessun `require`); la rete la fa chi cabla, e passa da qui iniettata.
//
// ═══ IL FATTO, MISURATO ═════════════════════════════════════════════════════════════════════════════
// 18 agosto 2026. `presidio-posizioni-vecchie` distingue una posizione normale da un residuo **sotto il
// minimo del venue**, e da quella distinzione dipende R6: sotto il minimo la vendita puo' non bastare e
// si valuta lo sblocco (comprare l'altro lato e fondere). Il ramo e' `if (c.sottoMinimo === true)`.
//
// Ma `minSizePerMercato` si costruiva da UNA fonte sola — **il board** — e il board contiene solo i
// mercati premiati di adesso. Un mercato che esce dal board perde il suo minimo, quindi `sottoMinimo`
// resta `false`, quindi **il ramo non si raggiunge mai**. E uscire dal board e' lo stato NORMALE di una
// posizione vecchia: e' proprio il caso per cui il presidio esiste.
//
// Misurato sulla posizione viva (Hong Kong `0xe9b3e28d`, 6 share):
//   · board (120 righe)        ⇒ ASSENTE
//   · catalogo di ripiego (23) ⇒ ASSENTE
//   · Gamma                    ⇒ ASSENTE («mercato non trovato per questo conditionId», 12 volte in un giorno)
//   · CLOB                     ⇒ `rewards.min_size = 20` — 6 < 20, quindi sotto il minimo, e nessuno lo sapeva
//
// ⚠ NON E' UN'ASSENZA QUALUNQUE: e' un'assenza che si traveste da risposta. Senza minimo il presidio non
// dice «non so», dice «non e' sotto il minimo» — e prova a venderla come una posizione qualunque. E' la
// classe `Number(null) === 0` di §5.3 nella sua forma piu' costosa: «non ho letto» diventa «non c'e'».
//
// ═══ LE TRE FONTI, IN ORDINE, E PERCHE' QUEST'ORDINE ════════════════════════════════════════════════
//   ① **board** — vivo, riscritto ogni 15 minuti. Chi c'e' vince sempre.
//   ② **catalogo di ripiego** — una fotografia, con la sua eta'. Risponde per chi il board non conosce.
//      E' la stessa precedenza di `resolveMarketRules` (board → catalogo), scritta una seconda volta
//      qui perche' quella funzione risponde a un'altra domanda; il valore che restituisce e' lo stesso.
//   ③ **venue (CLOB)** — si chiede solo quando le prime due tacciono, **e si SCRIVE nel catalogo**, cosi'
//      la seconda fonte impara e la terza non si richiede piu'. E' la stessa forma di
//      `scadenza-recupero.js`, per la stessa ragione: una lettura di rete che non si posa da nessuna
//      parte e' una lettura da rifare per sempre.
//
// ⚠ IL MINIMO DEVE ESSERE UN NUMERO FINITO E MAGGIORE DI ZERO, o non e' una risposta. Un `minSize` a 0
// significherebbe «niente e' sotto il minimo», cioe' esattamente la bugia che questo modulo esiste per
// impedire. `Number(null)`, `Number('')` e `Number(undefined)` non passano di qui: un campo che non si
// legge lascia il mercato fra i MANCANTI, dove almeno si vede.
//
// ⚠ E UN MERCATO SENZA PROGRAMMA PREMIANTE NON HA UN MINIMO PREMIANTE. Il venue risponde, e la risposta
// e' «non pubblico `min_size`»: non e' un guasto, ed e' giusto che quel mercato NON venga marcato
// sotto-minimo. La conseguenza e' la strada principale di R6 — si prova a venderlo — che e' anche la
// direzione prudente: lo sblocco compra, la vendita riduce.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Quanti mercati si chiedono al venue in un giro. Sono posizioni aperte: unita', non centinaia. */
const MAX_PER_GIRO = 5;
/** Chi ha gia' fallito non si richiede prima di questo tempo: un mercato che il venue non conosce non
 *  deve produrre una richiesta ogni due minuti per sempre. Stesso valore di `scadenza-recupero`. */
const RITENTA_MS = 30 * 60_000;

/** Il minimo, se questo valore e' una risposta. Non lo e' se non e' finito o non e' positivo. */
function minimoDa(x) {
  const n = Number(x);
  return fin(n) && n > 0 ? n : null;
}

/**
 * IL MINIMO PREMIANTE PER OGNI MERCATO CHIESTO, DALLE DUE FONTI GIA' SU DISCO. Pura.
 *
 * @param a.conditionIds  gli id su cui serve il minimo (i mercati con una posizione aperta)
 * @param a.board         l'array di righe del board reward (`rewardsMinSize`), o null
 * @param a.catalogo      la mappa id ⇒ record del catalogo di ripiego (`rewardsMinSize`), o null
 * @returns {{minSize:object, fonte:object, mancanti:string[]}}
 */
function risolvi({ conditionIds = [], board = null, catalogo = null } = {}) {
  const minSize = {};
  const fonte = {};
  const mancanti = [];

  const daBoard = new Map();
  if (Array.isArray(board)) {
    for (const r of board) {
      const id = normId(r && r.conditionId);
      const v = minimoDa(r && r.rewardsMinSize);
      if (id && v !== null && !daBoard.has(id)) daBoard.set(id, v);
    }
  }
  const cat = (catalogo && typeof catalogo === 'object') ? catalogo : {};

  const visti = new Set();
  for (const raw of (conditionIds || [])) {
    const id = normId(raw);
    if (!id || visti.has(id)) continue;
    visti.add(id);
    if (daBoard.has(id)) { minSize[id] = daBoard.get(id); fonte[id] = 'board'; continue; }
    // ⚠ Il catalogo si indicizza per id normalizzato, ma una chiave scritta da qualcun altro potrebbe
    // non esserlo: si guarda prima la chiave diretta, poi si confronta normalizzando. E' la stessa
    // prudenza di `chiusura-di-emergenza`, dove una chiave maiuscola aveva gia' fatto danno.
    let rec = cat[id];
    if (!rec) { for (const k of Object.keys(cat)) { if (normId(k) === id) { rec = cat[k]; break; } } }
    const v = minimoDa(rec && rec.rewardsMinSize);
    if (v !== null) { minSize[id] = v; fonte[id] = 'catalogo'; continue; }
    mancanti.push(id);
  }
  return { minSize, fonte, mancanti };
}

/**
 * QUALI FRA I MANCANTI SI CHIEDONO AL VENUE ADESSO. Pura: la rete la fa `recuperaDalVenue`.
 * Chi ha fallito da meno di `RITENTA_MS` si salta; al piu' `maxPerGiro` per giro.
 */
function daChiedere({ mancanti = [], falliti = {}, now = Date.now(), maxPerGiro = MAX_PER_GIRO } = {}) {
  const out = [];
  const visti = new Set();
  for (const raw of (mancanti || [])) {
    const id = normId(raw);
    if (!id || visti.has(id)) continue;
    visti.add(id);
    const ultimo = falliti && fin(falliti[id]) ? falliti[id] : null;
    if (ultimo != null && (now - ultimo) < RITENTA_MS) continue;
    out.push(id);
    if (out.length >= Math.max(1, maxPerGiro)) break;
  }
  return out;
}

/**
 * LA TERZA FONTE. Chiede il minimo al venue per i mercati che ne' il board ne' il catalogo conoscono,
 * e **posa la lettura nel catalogo di ripiego** perche' al giro dopo risponda la seconda fonte.
 *
 * ⚠ IL VALORE SI USA ANCHE SE IL SALVATAGGIO FALLISCE. La lettura e' buona: negarla al presidio perche'
 * un file non si e' scritto vorrebbe dire lasciare un residuo bloccato per un problema di disco. Il
 * mercato resta pero' fra i `falliti`, cosi' il salvataggio si riprova — si perde la persistenza, non
 * la decisione. E' la differenza con `scadenza-recupero`, dove il lettore a valle e' SINCRONO e senza
 * persistenza il dato non arriverebbe a nessuno.
 *
 * ⚠ NON SI INVENTA UN MINIMO. Venue irraggiungibile, mercato sconosciuto, `min_size` assente o non
 * positivo ⇒ non si scrive niente, il mercato resta senza minimo e si dichiara il motivo. Un minimo
 * indovinato manderebbe una posizione sana nel ramo dello sblocco, che COMPRA.
 *
 * @param a.mancanti    gli id senza minimo (l'uscita di `risolvi`)
 * @param a.falliti     mappa id ⇒ istante dell'ultimo tentativo fallito (vive nel processo)
 * @param a.leggiVenue  async (marketId) ⇒ l'esito di `leggiVenueClob`. OBBLIGATORIA.
 * @param a.salva       (marketId, lettura) ⇒ { ok } — scrive nel catalogo di ripiego. Opzionale.
 * @returns {{chiesti:number, minSize:object, recuperati:Array, nonTrovati:Array, falliti:object}}
 */
async function recuperaDalVenue({ mancanti = [], falliti = {}, leggiVenue = null, salva = null,
  now = Date.now(), maxPerGiro = MAX_PER_GIRO } = {}) {
  const ids = daChiedere({ mancanti, falliti, now, maxPerGiro });
  const minSize = {};
  const recuperati = [];
  const nonTrovati = [];
  const nuoviFalliti = { ...falliti };
  if (!ids.length) return { chiesti: 0, minSize, recuperati, nonTrovati, falliti: nuoviFalliti };
  if (typeof leggiVenue !== 'function') {
    return { chiesti: 0, minSize, recuperati,
      nonTrovati: ids.map((id) => ({ marketId: id, motivo: 'nessun lettore del venue iniettato' })),
      falliti: nuoviFalliti };
  }

  for (const id of ids) {
    let v = null;
    try { v = await leggiVenue(id); } catch (e) { v = { readable: false, error: e && e.message ? e.message : String(e) }; }
    if (!v || v.readable !== true) {
      nuoviFalliti[id] = now;
      nonTrovati.push({ marketId: id, motivo: (v && v.error) || 'lettura del venue non riuscita' });
      continue;
    }
    const m = minimoDa(v.minSizeShares);
    if (m === null) {
      // ⚠ QUESTO NON E' UN GUASTO: e' un mercato senza programma premiante, e la risposta e' «non c'e'
      // un minimo premiante». Si segna comunque fra i falliti perche' non ha senso richiederlo ogni due
      // minuti, ma il motivo lo distingue da un venue che non risponde.
      nuoviFalliti[id] = now;
      nonTrovati.push({ marketId: id, motivo: 'il venue non pubblica un minimo premiante per questo mercato (nessun programma reward)' });
      continue;
    }
    minSize[id] = m;
    let salvato = false;
    let motivoSalvataggio = null;
    if (typeof salva === 'function') {
      try {
        const w = await salva(id, v);
        salvato = !!(w && w.ok !== false);
        if (!salvato) motivoSalvataggio = (w && w.error) || 'scrittura nel catalogo di ripiego rifiutata';
      } catch (e) { salvato = false; motivoSalvataggio = e && e.message ? e.message : String(e); }
    } else { motivoSalvataggio = 'nessuno scrittore del catalogo iniettato'; }
    if (salvato) delete nuoviFalliti[id]; else nuoviFalliti[id] = now;
    recuperati.push({ marketId: id, minSize: m, salvato, motivoSalvataggio });
  }
  return { chiesti: ids.length, minSize, recuperati, nonTrovati, falliti: nuoviFalliti };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; } else { f += 1; console.error(`  ✗ ${n}`); } };
  console.log('\n════ min-size-mercato ════');
  const A = '0x' + 'a'.repeat(64);
  const B = '0x' + 'b'.repeat(64);
  const C = '0x' + 'c'.repeat(64);
  const T = 1_000_000_000_000;

  // ── LE DUE FONTI SU DISCO, E LA LORO PRECEDENZA ─────────────────────────────────────────────────
  const r1 = risolvi({ conditionIds: [A], board: [{ conditionId: A, rewardsMinSize: 50 }] });
  ok('il board risponde', r1.minSize[A] === 50 && r1.fonte[A] === 'board' && r1.mancanti.length === 0);
  const r2 = risolvi({ conditionIds: [A], board: [], catalogo: { [A]: { rewardsMinSize: 20 } } });
  ok('il catalogo risponde per chi il board non conosce', r2.minSize[A] === 20 && r2.fonte[A] === 'catalogo');
  const r3 = risolvi({ conditionIds: [A], board: [{ conditionId: A, rewardsMinSize: 50 }],
    catalogo: { [A]: { rewardsMinSize: 20 } } });
  ok('  ma il board VINCE sul catalogo: e\' vivo, il catalogo e\' una fotografia',
    r3.minSize[A] === 50 && r3.fonte[A] === 'board');
  ok('maiuscole nella chiave del catalogo: risponde lo stesso',
    risolvi({ conditionIds: [A], catalogo: { [A.toUpperCase()]: { rewardsMinSize: 20 } } }).minSize[A] === 20);
  ok('id chiesto in maiuscolo: risponde lo stesso',
    risolvi({ conditionIds: [A.toUpperCase()], board: [{ conditionId: A, rewardsMinSize: 50 }] }).minSize[A] === 50);

  // ── «NON HO LETTO» NON DIVENTA MAI «NON C'E'» ───────────────────────────────────────────────────
  ok('nessuna fonte ⇒ MANCANTE, non zero',
    risolvi({ conditionIds: [A] }).mancanti[0] === A && risolvi({ conditionIds: [A] }).minSize[A] === undefined);
  for (const [nome, val] of [['null', null], ['undefined', undefined], ['stringa vuota', ''],
    ['zero', 0], ['negativo', -5], ['NaN', NaN], ['non numerico', 'boh']]) {
    const r = risolvi({ conditionIds: [A], board: [{ conditionId: A, rewardsMinSize: val }] });
    ok(`  rewardsMinSize ${nome} ⇒ mancante, mai una risposta`,
      r.mancanti[0] === A && r.minSize[A] === undefined);
  }
  ok('board illeggibile (null) ⇒ tutti mancanti, nessuna eccezione',
    risolvi({ conditionIds: [A, B], board: null, catalogo: null }).mancanti.length === 2);
  ok('id duplicati si chiedono una volta sola',
    risolvi({ conditionIds: [A, A, A] }).mancanti.length === 1);

  // ── CHI SI CHIEDE AL VENUE ──────────────────────────────────────────────────────────────────────
  ok('chi non ha mai fallito si chiede', daChiedere({ mancanti: [A], now: T })[0] === A);
  ok('chi ha fallito da poco NON si richiede',
    daChiedere({ mancanti: [A], falliti: { [A]: T - 60_000 }, now: T }).length === 0);
  ok('  ma dopo la finestra si', daChiedere({ mancanti: [A], falliti: { [A]: T - RITENTA_MS - 1 }, now: T })[0] === A);
  ok('il tetto per giro morde', daChiedere({ mancanti: [A, B, C], now: T, maxPerGiro: 2 }).length === 2);

  // ── LA TERZA FONTE ──────────────────────────────────────────────────────────────────────────────
  const V = { readable: true, minSizeShares: 20, tick: 0.001, negRisk: true, tokenIdYes: '1', tokenIdNo: '2' };
  return (async () => {
    let salvati = [];
    let r = await recuperaDalVenue({ mancanti: [A], now: T,
      leggiVenue: async () => V, salva: async (id, v) => { salvati.push([id, v]); return { ok: true }; } });
    ok('il venue risponde: minimo recuperato, salvato, e non resta fra i falliti',
      r.minSize[A] === 20 && r.recuperati[0].salvato === true && r.falliti[A] === undefined && salvati.length === 1);
    ok('  e la lettura INTERA arriva allo scrittore, non solo il numero', salvati[0][1] === V);

    salvati = [];
    r = await recuperaDalVenue({ mancanti: [A], now: T, leggiVenue: async () => V, salva: async () => ({ ok: false, error: 'disco pieno' }) });
    ok('salvataggio fallito: il VALORE si usa lo stesso, ma si riprovera\'',
      r.minSize[A] === 20 && r.recuperati[0].salvato === false && r.falliti[A] === T);

    r = await recuperaDalVenue({ mancanti: [A], now: T, leggiVenue: async () => ({ readable: false, error: 'HTTP 404' }) });
    ok('venue illeggibile: nessun minimo, motivo in chiaro, e si riprova dopo la finestra',
      r.minSize[A] === undefined && /404/.test(r.nonTrovati[0].motivo) && r.falliti[A] === T);

    r = await recuperaDalVenue({ mancanti: [A], now: T, leggiVenue: async () => ({ readable: true, minSizeShares: null }) });
    ok('venue che risponde SENZA minimo premiante: non e\' un guasto, e non si inventa un minimo',
      r.minSize[A] === undefined && /nessun programma reward/.test(r.nonTrovati[0].motivo));

    r = await recuperaDalVenue({ mancanti: [A], now: T, leggiVenue: async () => { throw new Error('rete giu\''); } });
    ok('un lettore che ESPLODE non ferma il giro', r.nonTrovati.length === 1 && /rete giu/.test(r.nonTrovati[0].motivo));

    r = await recuperaDalVenue({ mancanti: [A], now: T, leggiVenue: null });
    ok('nessun lettore iniettato: si dichiara, non si finge', r.chiesti === 0 && /nessun lettore/.test(r.nonTrovati[0].motivo));

    r = await recuperaDalVenue({ mancanti: [], now: T, leggiVenue: async () => V });
    ok('niente da chiedere: nessuna chiamata di rete', r.chiesti === 0 && r.nonTrovati.length === 0);

    // ⚠ IL CASO VERO, DA CAPO A FONDO: il mercato non e' ne' sul board ne' nel catalogo, il venue lo
    // conosce, e la posizione da 6 share risulta finalmente SOTTO il minimo di 20.
    const vuoto = risolvi({ conditionIds: [A], board: [], catalogo: {} });
    const rec = await recuperaDalVenue({ mancanti: vuoto.mancanti, now: T, leggiVenue: async () => V, salva: async () => ({ ok: true }) });
    const unito = { ...vuoto.minSize, ...rec.minSize };
    ok('HONG KONG: fuori dal board e dal catalogo, il venue da\' 20 e 6 share sono SOTTO il minimo',
      unito[A] === 20 && 6 < unito[A]);

    console.log(`\nmin-size-mercato: ${p} passati, ${f} falliti`);
    return f === 0;
  })();
}

module.exports = { risolvi, daChiedere, recuperaDalVenue, minimoDa, MAX_PER_GIRO, RITENTA_MS, selfcheck };

if (require.main === module) selfcheck().then((o) => process.exit(o ? 0 : 1));

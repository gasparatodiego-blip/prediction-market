'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  UNA POSIZIONE SENZA SCADENZA LEGGIBILE È UNA POSIZIONE CHE NESSUNO CHIUDERÀ MAI
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IL FATTO, con i numeri (13 agosto 2026). Sette posizioni aperte, **cinque fuori dal board** —
 * Wellington, Munich, Warsaw, Ankara, Hong Kong — e per tutte e cinque il catalogo di ripiego portava
 * `endDate: null`. `scadenzaMercato` (agent40) legge board → ripiego e, non trovando niente, risponde
 * `null`; `chiusuraForzataPreScadenza` con una scadenza `null` risponde `forza:false`. Cioè la regola
 * «entro tre ore dalla risoluzione si chiude a qualunque prezzo» — che è una regola di RISCHIO — era
 * spenta esattamente sulle posizioni che ne avevano bisogno: quelle che stanno per risolvere e che
 * proprio per questo non sono più sul tabellone.
 *
 * La causa prima era un campo non mappato (`market-catalog.recordDaRigaBoard`, corretto lo stesso
 * giorno). Ma correggerlo non basta e non poteva bastare: i record già scritti restano senza data, e
 * un mercato che non è MAI passato dal board non ne avrebbe comunque una. Serve la terza fonte.
 *
 * ═══ LA TERZA FONTE È IL VENUE, E SI CHIEDE SOLO QUANDO LE PRIME DUE TACCIONO ═══════════════════════
 * `recuperaScadenze` prende gli id per cui la scadenza non si legge, ne interroga il venue e **scrive
 * il risultato nel catalogo di ripiego**. Da lì `scadenzaMercato` — che resta SINCRONA e non viene
 * toccata — la trova al ciclo successivo. È deliberato: rendere asincrona una funzione che vive dentro
 * il ciclo di chiusura vorrebbe dire toccare ogni suo chiamante per un dato che cambia una volta nella
 * vita di un mercato.
 *
 * ═══ COSA NON FA ═══════════════════════════════════════════════════════════════════════════════════
 * Non chiude niente, non piazza niente, non cancella niente. Scrive **un solo campo** su un catalogo di
 * metadati, e come dice l'intestazione di `market-catalog` un metadato non rende piazzabile un mercato:
 * può solo far sì che una decisione venga presa con il dato invece che senza.
 *
 * ⚠ E NON SI INVENTA UNA DATA. Venue irraggiungibile, mercato sconosciuto, `endDate` assente o non
 * parsabile ⇒ non si scrive niente e si dichiara il motivo. Una scadenza indovinata è peggio di una
 * scadenza mancante: la seconda lascia la posizione aperta, la prima la fa vendere al momento sbagliato.
 *
 * ═══ IL COSTO ══════════════════════════════════════════════════════════════════════════════════════
 * Una richiesta per mercato senza data, al più `MAX_PER_GIRO` per giro, e **solo per i mercati su cui
 * abbiamo una posizione** — che sono unità, non centinaia. Una volta scritta, la data non si richiede
 * più: il ricordo sta su disco. Chi ha già fallito non si richiede prima di `RITENTA_MS`, così un
 * mercato che il venue non conosce non produce una richiesta ogni minuto per sempre.
 */

const fin = (v) => Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

const MAX_PER_GIRO = 5;
const RITENTA_MS = 30 * 60_000;

/** La scadenza si legge da questo record? Stessa lettura di `scadenzaMercato`, un posto solo. */
function scadenzaDa(record) {
  if (!record) return null;
  const t = Date.parse(record.endDate || record.endDateIso || record.end_date_iso || record.endDateUtc || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * QUALI MERCATI HANNO BISOGNO DEL RECUPERO.
 *
 * Puro: riceve gli id da coprire e le due letture già in mano, restituisce la lista da chiedere. Chi
 * chiama fa la rete. Così la regola — «si chiede solo se board E ripiego tacciono» — si prova senza
 * allestire un venue.
 *
 * @param marketIds   gli id su cui abbiamo capitale (posizioni, ordini)
 * @param scadenzaNota funzione sincrona id ⇒ ms|null: è `scadenzaMercato`, non una seconda lettura
 * @param falliti     mappa id ⇒ istante dell'ultimo tentativo fallito
 */
function daRecuperare({ marketIds = [], scadenzaNota = null, falliti = {}, now = Date.now(), maxPerGiro = MAX_PER_GIRO } = {}) {
  const out = [];
  const visti = new Set();
  for (const raw of (marketIds || [])) {
    const id = normId(raw);
    if (!id || visti.has(id)) continue;
    visti.add(id);
    let nota = null;
    // Una lettura che ESPLODE vale «non so», non «non serve»: il verso che tenta il recupero.
    try { nota = typeof scadenzaNota === 'function' ? scadenzaNota(id) : null; } catch { nota = null; }
    if (fin(nota)) continue;
    const ultimo = falliti && fin(falliti[id]) ? falliti[id] : null;
    if (ultimo != null && (now - ultimo) < RITENTA_MS) continue;
    out.push(id);
    if (out.length >= maxPerGiro) break;
  }
  return out;
}

/**
 * IL RECUPERO VERO. `fetchOne` e `salva` sono iniettati: senza di loro questo modulo non tocca né la
 * rete né il disco, ed è la ragione per cui il suo test non ha bisogno di nessuno dei due.
 *
 * @param fetchOne  async id ⇒ `{ ok, market:{ endDate } }` — di difetto `market-search.fetchMarketByConditionId`
 * @param salva     ({ marketId, endDate }) ⇒ scrive nel catalogo di ripiego
 * @returns {{chiesti:number, recuperati:Array, nonTrovati:Array, falliti:object}}
 */
async function recuperaScadenze({
  marketIds = [], scadenzaNota = null, falliti = {}, fetchOne = null, salva = null,
  now = Date.now(), maxPerGiro = MAX_PER_GIRO,
} = {}) {
  const ids = daRecuperare({ marketIds, scadenzaNota, falliti, now, maxPerGiro });
  const recuperati = [];
  const nonTrovati = [];
  const nuoviFalliti = { ...falliti };
  if (!ids.length) return { chiesti: 0, recuperati, nonTrovati, falliti: nuoviFalliti };
  if (typeof fetchOne !== 'function') {
    return { chiesti: 0, recuperati, nonTrovati: ids.map((id) => ({ marketId: id, motivo: 'nessun lettore del venue iniettato' })), falliti: nuoviFalliti };
  }

  for (const id of ids) {
    let r = null;
    try { r = await fetchOne(id); } catch (e) { r = { ok: false, error: e && e.message }; }
    const end = r && r.ok === true && r.market ? r.market.endDate : null;
    const t = typeof end === 'string' && Number.isFinite(Date.parse(end)) ? Date.parse(end) : null;
    if (t == null) {
      // Non si scrive NIENTE: né una data indovinata, né un marcatore che finga di essere una data.
      nuoviFalliti[id] = now;
      nonTrovati.push({ marketId: id, motivo: (r && (r.error || 'il venue non pubblica una scadenza leggibile')) || 'risposta vuota' });
      continue;
    }
    let scritto = false;
    let motivo = null;
    try {
      const w = typeof salva === 'function' ? salva({ marketId: id, endDate: end }) : null;
      scritto = !!(w && w.ok !== false);
      if (!scritto) motivo = (w && w.error) || 'scrittura nel catalogo di ripiego rifiutata';
    } catch (e) { scritto = false; motivo = e && e.message; }
    if (scritto) {
      delete nuoviFalliti[id];
      recuperati.push({ marketId: id, endDate: end, endMs: t });
    } else {
      nuoviFalliti[id] = now;
      nonTrovati.push({ marketId: id, motivo: `scadenza letta ma non salvata: ${motivo}` });
    }
  }
  return { chiesti: ids.length, recuperati, nonTrovati, falliti: nuoviFalliti };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (nome, cond) => { if (cond) p += 1; else { f += 1; console.error('  ✗', nome); } };
  const T0 = 1_000_000_000_000;
  const A = '0x' + 'a'.repeat(64);
  const B = '0x' + 'b'.repeat(64);
  const C = '0x' + 'c'.repeat(64);

  ok('chi ha già la scadenza non si chiede',
    daRecuperare({ marketIds: [A], scadenzaNota: () => T0 + 3600_000, now: T0 }).length === 0);
  ok('chi non ce l\'ha si chiede',
    daRecuperare({ marketIds: [A], scadenzaNota: () => null, now: T0 })[0] === A);
  ok('una lettura che esplode vale «non so» e tenta il recupero',
    daRecuperare({ marketIds: [A], scadenzaNota: () => { throw new Error('board illeggibile'); }, now: T0 }).length === 1);
  ok('chi ha fallito da poco non si richiede',
    daRecuperare({ marketIds: [A], scadenzaNota: () => null, falliti: { [A]: T0 - 60_000 }, now: T0 }).length === 0);
  ok('e dopo la finestra si',
    daRecuperare({ marketIds: [A], scadenzaNota: () => null, falliti: { [A]: T0 - RITENTA_MS - 1 }, now: T0 }).length === 1);
  ok('il tetto per giro morde',
    daRecuperare({ marketIds: [A, B, C], scadenzaNota: () => null, now: T0, maxPerGiro: 2 }).length === 2);
  ok('gli id doppi si chiedono una volta sola',
    daRecuperare({ marketIds: [A, A, A], scadenzaNota: () => null, now: T0 }).length === 1);

  return (async () => {
    const scritti = [];
    const salva = ({ marketId, endDate }) => { scritti.push({ marketId, endDate }); return { ok: true }; };

    let r = await recuperaScadenze({
      marketIds: [A], scadenzaNota: () => null, now: T0, salva,
      fetchOne: async () => ({ ok: true, market: { endDate: '2026-08-14T16:00:00Z' } }),
    });
    ok('la scadenza recuperata finisce nel catalogo', r.recuperati.length === 1 && scritti.length === 1 && scritti[0].endDate === '2026-08-14T16:00:00Z');

    r = await recuperaScadenze({ marketIds: [B], scadenzaNota: () => null, now: T0, salva, fetchOne: async () => ({ ok: false, error: '429' }) });
    ok('venue irraggiungibile: niente scritto, fallimento memorizzato', r.recuperati.length === 0 && r.nonTrovati.length === 1 && fin(r.falliti[B]));

    r = await recuperaScadenze({ marketIds: [C], scadenzaNota: () => null, now: T0, salva, fetchOne: async () => ({ ok: true, market: { endDate: 'domani' } }) });
    ok('una data non parsabile non viene MAI scritta', r.recuperati.length === 0 && scritti.length === 1);

    r = await recuperaScadenze({ marketIds: [C], scadenzaNota: () => null, now: T0, salva, fetchOne: async () => { throw new Error('rete giu'); } });
    ok('un lettore che esplode non propaga', r.nonTrovati.length === 1);

    r = await recuperaScadenze({
      marketIds: [A], scadenzaNota: () => null, now: T0,
      salva: () => ({ ok: false, error: 'record incompleto' }),
      fetchOne: async () => ({ ok: true, market: { endDate: '2026-08-14T16:00:00Z' } }),
    });
    ok('letta ma non salvata NON conta come recuperata', r.recuperati.length === 0 && /non salvata/.test(r.nonTrovati[0].motivo));

    r = await recuperaScadenze({ marketIds: [A], scadenzaNota: () => null, now: T0, salva, fetchOne: null });
    ok('senza lettore iniettato non si finge di aver chiesto', r.chiesti === 0 && r.nonTrovati.length === 1);

    console.log(`scadenza-recupero selfcheck: ${p} passati, ${f} falliti`);
    return f === 0;
  })();
}

module.exports = { daRecuperare, recuperaScadenze, scadenzaDa, selfcheck, MAX_PER_GIRO, RITENTA_MS };

if (require.main === module) selfcheck().then((v) => process.exit(v ? 0 : 1));

'use strict';
// lib/maker/scansione-registri.js — LA PULIZIA NON DIPENDE DA CHI ITERA COSA.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// La pulizia dei registri (§5 punto 77) parte da `auto-close`, che itera le POSIZIONI. Un mercato risolto
// o morto **senza posizione** ma con voci residue nei registri non viene mai visitato, e quelle voci
// restano lì per sempre. `end-of-life-cancel` in `auto-reprice` chiude gli ordini ma non chiama la
// pulizia — e comunque legge l'OROLOGIO del mercato, non lo stato del venue, quindi non vede un mercato
// annullato prima della sua scadenza nominale.
//
// Il risultato è una lacuna che si allarga da sola: ogni mercato che muore in uno stato «senza
// posizione» lascia dietro voci che nessun ciclo raggiungerà mai più.
//
// ═══ LA DECISIONE (12 agosto 2026) ═══════════════════════════════════════════════════════════════════
// La pulizia smette di essere un effetto collaterale di un ciclo che sta facendo altro e diventa una
// **scansione sua**, che itera l'UNIONE di tre insiemi:
//   · mercati con POSIZIONE aperta        (snapshot del venue)
//   · mercati con ORDINI a riposo         (lettura del venue)
//   · mercati con VOCI nei registri       (i sei registri operativi, residui sotto minimo compresi)
// Il terzo è quello che mancava, ed è per costruzione l'unico che può contenere un mercato che nessun
// altro insieme nomina più.
//
// ═══ CHI SI INTERROGA, E CHI NO ══════════════════════════════════════════════════════════════════════
// Per ogni mercato dell'unione che NON è più sul board si chiede al venue com'è messo. Chi è sul board
// non si interroga: è vivo per definizione, e chiedere costerebbe una richiesta per confermare un sì.
// È lo stesso criterio con cui `reward-riprova` non rimette in discussione un «no» già dato.
//
// ═══ COSA PULISCE, E COSA NON TOCCA MAI ══════════════════════════════════════════════════════════════
// Pulisce solo mercati **chiusi o risolti sul venue**, e solo a **libro libero** — le due condizioni le
// verifica `pulizia-mercato-chiuso`, che questo modulo riusa invece di riscriverle.
//
// NESSUN GIORNALE VIENE CANCELLATO, MAI. Si puliscono i registri OPERATIVI — cioè lo stato corrente su
// cui i cicli decidono — non la storia. I giornali append-only non sono nemmeno NOMINATI da questo
// modulo, e un test lo verifica per assenza: e' una proprieta' piu' forte di una promessa, perche' non
// si puo' cancellare un file di cui non si conosce il nome.
//
// ═══ CADENZA: 30 MINUTI, E UNA VOLTA ALL'AVVIO ═══════════════════════════════════════════════════════
// All'avvio perché è il momento in cui è più probabile che ci siano voci vecchie (un processo che
// riparte dopo ore di fermo), e ogni 30 minuti perché è una scansione di manutenzione: un mercato che
// muore non ha fretta di essere dimenticato, e una cadenza stretta costerebbe letture del venue per
// confermare ogni volta la stessa cosa.
//
// ═══ PURO ════════════════════════════════════════════════════════════════════════════════════════════
// Non apre file e non parla col venue: ogni fonte arriva iniettata. La regola si prova senza disco e
// senza rete, e chi possiede il disco (agent40) resta l'unico a scriverlo.

const { mercatoMorto, pulisciRegistri } = require('./pulizia-mercato-chiuso');

const CADENZA_MS = 30 * 60_000;

const norm = (x) => String(x || '').toLowerCase();

/**
 * L'UNIONE DEI TRE INSIEMI. Pura.
 *
 * ⚠ UNA FONTE CHE NON SI LEGGE NON RESTRINGE L'UNIONE E NON LA GONFIA: contribuisce zero mercati e
 * viene DICHIARATA. La differenza conta: se lo snapshot delle posizioni non si legge, l'unione è più
 * piccola e qualche mercato non verrà esaminato questo giro — che è innocuo, si riprova fra 30 minuti.
 * Se invece si trattasse l'assenza come «nessuna posizione», un mercato con posizione aperta potrebbe
 * finire fra i candidati alla pulizia, e la pulizia toglie il tetto e la gestione manuale.
 *
 * @returns {{mercati:string[], daPosizioni:number, daOrdini:number, daRegistri:number,
 *            fontiNonLette:string[], soloRegistri:string[]}}
 */
function unioneMercati({ posizioni = null, ordini = null, registri = null } = {}) {
  const set = new Set();
  const fontiNonLette = [];
  const daRegistriSet = new Set();

  let daPosizioni = 0;
  if (Array.isArray(posizioni)) {
    for (const p of posizioni) { const id = norm(p && (p.marketId || p.conditionId)); if (id) { set.add(id); daPosizioni += 1; } }
  } else { fontiNonLette.push('posizioni'); }

  let daOrdini = 0;
  if (Array.isArray(ordini)) {
    for (const o of ordini) { const id = norm(o && (o.marketId || o.conditionId)); if (id) { set.add(id); daOrdini += 1; } }
  } else { fontiNonLette.push('ordini'); }

  let daRegistri = 0;
  if (Array.isArray(registri)) {
    for (const r of registri) {
      const id = norm(r);
      if (id) { set.add(id); daRegistriSet.add(id); daRegistri += 1; }
    }
  } else { fontiNonLette.push('registri'); }

  // I mercati che ESISTONO SOLO nei registri: sono esattamente quelli che nessun ciclo visita più, cioè
  // la ragione per cui questa scansione esiste. Contarli a parte rende misurabile il difetto.
  const vivi = new Set();
  for (const p of Array.isArray(posizioni) ? posizioni : []) { const id = norm(p && (p.marketId || p.conditionId)); if (id) vivi.add(id); }
  for (const o of Array.isArray(ordini) ? ordini : []) { const id = norm(o && (o.marketId || o.conditionId)); if (id) vivi.add(id); }
  const soloRegistri = [...daRegistriSet].filter((id) => !vivi.has(id));

  return { mercati: [...set], daPosizioni, daOrdini, daRegistri, fontiNonLette, soloRegistri };
}

/**
 * LA SCANSIONE. Iniettata in tutto: `suBoard`, `statoVenue`, `ordiniDelMercato`, `registri`.
 *
 * @param a.suBoard          (marketId) => boolean — chi è sul board non si interroga
 * @param a.statoVenue       async (marketId) => {closed, acceptingOrders} | null
 * @param a.ordiniDelMercato (marketId) => number|null — quanti nostri ordini a riposo. `null` = non
 *                           letto, e allora NON si pulisce (libro non provato vuoto).
 * @param a.registri         le sei mani di `pulizia-mercato-chiuso.pulisciRegistri`
 * @returns {{esaminati:number, interrogati:number, morti:number, puliti:number, saltati:number,
 *            dettaglio:Array, unione:object}}
 */
async function scansiona({ posizioni = null, ordini = null, registri = null,
  suBoard = null, statoVenue = null, ordiniDelMercato = null, maniRegistri = null,
  tettoInterrogazioni = 40 } = {}) {
  const u = unioneMercati({ posizioni, ordini, registri });
  let interrogati = 0; let morti = 0; let puliti = 0; let saltati = 0;
  const dettaglio = [];

  for (const id of u.mercati) {
    // ── CHI È SUL BOARD È VIVO PER DEFINIZIONE ────────────────────────────────────────────────────
    // `suBoard` non cablato ⇒ si interroga tutto: più lento, mai sbagliato.
    if (typeof suBoard === 'function') {
      let sul = false;
      try { sul = suBoard(id) === true; } catch { sul = false; }
      if (sul) { saltati += 1; continue; }
    }
    if (typeof statoVenue !== 'function') { saltati += 1; continue; }
    if (interrogati >= tettoInterrogazioni) {
      // Il tetto non produce una conclusione: si riprova al giro dopo, fra 30 minuti.
      saltati += 1;
      dettaglio.push({ marketId: id, esito: 'oltre-il-tetto' });
      continue;
    }

    interrogati += 1;
    let venue = null;
    try { venue = await statoVenue(id); } catch { venue = null; }
    const m = mercatoMorto({ venue });
    if (!m.morto) { dettaglio.push({ marketId: id, esito: 'vivo', motivo: m.motivo }); continue; }
    morti += 1;

    // ── SOLO A LIBRO LIBERO, E «NON L'HO LETTO» VALE NO ───────────────────────────────────────────
    // ⚠ SESTA OCCORRENZA DI `Number(null) === 0` IN QUESTO REPO, e trovata di nuovo da una prova e non
    // dal ragionamento (§5 punti 66, 68, 77 e due volte l'11 agosto). `Number.isFinite(Number(null))` e'
    // TRUE, quindi «non ho letto gli ordini» sarebbe diventato «zero ordini a riposo» — cioe' libro
    // provato vuoto — e la pulizia avrebbe tolto tetto e gestione manuale a un mercato su cui potremmo
    // avere un ordine vivo. Si guarda il valore GREZZO: solo un numero e' un numero.
    let quanti = null;
    if (typeof ordiniDelMercato === 'function') {
      try { const v = await ordiniDelMercato(id); quanti = (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
      catch { quanti = null; }
    }
    const libroLibero = quanti === 0;
    const pul = pulisciRegistri({ marketId: id, causa: m.causa, libroLibero, registri: maniRegistri || {} });
    if (pul.puliti.length) puliti += 1;
    dettaglio.push({ marketId: id, esito: m.causa, ordiniARiposo: quanti,
      puliti: pul.puliti, falliti: pul.falliti, motivo: pul.motivo });
  }

  return { esaminati: u.mercati.length, interrogati, morti, puliti, saltati, dettaglio, unione: u };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ scansione-registri ════');

  const u = unioneMercati({
    posizioni: [{ marketId: '0xA' }],
    ordini: [{ marketId: '0xB' }, { marketId: '0xa' }],
    registri: ['0xC', '0xA'],
  });
  ok('l\'unione deduplica e normalizza il case', u.mercati.length === 3);
  ok('  e conta le tre provenienze', u.daPosizioni === 1 && u.daOrdini === 2 && u.daRegistri === 2);
  ok('  i mercati che esistono SOLO nei registri sono contati a parte',
    u.soloRegistri.length === 1 && u.soloRegistri[0] === '0xc');

  const senza = unioneMercati({ posizioni: null, ordini: [{ marketId: '0xB' }], registri: ['0xC'] });
  ok('una fonte non letta contribuisce zero e viene DICHIARATA',
    senza.mercati.length === 2 && senza.fontiNonLette.includes('posizioni'));

  (async () => {
    const mani = () => Object.fromEntries(
      ['attesaMerge', 'residui', 'chiusura', 'tetto', 'manuale', 'autoClose'].map((k) => [k, () => ({ ok: true, rimosso: true })]));

    const r1 = await scansiona({
      posizioni: [], ordini: [], registri: ['0xmorto', '0xvivo'],
      suBoard: (id) => id === '0xvivo',
      statoVenue: async () => ({ closed: true }),
      ordiniDelMercato: async () => 0,
      maniRegistri: mani(),
    });
    ok('chi è sul board non si interroga', r1.interrogati === 1 && r1.saltati === 1);
    ok('  e il morto viene ripulito', r1.morti === 1 && r1.puliti === 1);

    const r2 = await scansiona({
      posizioni: [], ordini: [], registri: ['0xmorto'],
      statoVenue: async () => ({ closed: true }),
      ordiniDelMercato: async () => 3,
      maniRegistri: mani(),
    });
    ok('mercato morto ma con ordini a riposo ⇒ NON si pulisce', r2.morti === 1 && r2.puliti === 0);

    const r3 = await scansiona({
      posizioni: [], ordini: [], registri: ['0xmorto'],
      statoVenue: async () => ({ closed: true }),
      ordiniDelMercato: async () => { throw new Error('venue giù'); },
      maniRegistri: mani(),
    });
    ok('ordini non leggibili ⇒ NON si pulisce (libro non provato vuoto)', r3.puliti === 0);

    const r4 = await scansiona({
      posizioni: [], ordini: [], registri: ['0xvivo'],
      statoVenue: async () => ({ closed: false, acceptingOrders: true }),
      ordiniDelMercato: async () => 0, maniRegistri: mani(),
    });
    ok('un mercato vivo non si tocca', r4.morti === 0 && r4.puliti === 0);

    const r5 = await scansiona({
      posizioni: [], ordini: [], registri: ['0xa', '0xb', '0xc'],
      statoVenue: async () => ({ closed: true }), ordiniDelMercato: async () => 0,
      maniRegistri: mani(), tettoInterrogazioni: 2,
    });
    ok('il tetto limita le interrogazioni per giro', r5.interrogati === 2 && r5.saltati === 1);

    const r6 = await scansiona({ registri: ['0xa'], statoVenue: null, maniRegistri: mani() });
    ok('senza `statoVenue` non si conclude niente', r6.interrogati === 0 && r6.puliti === 0);

    ok('la cadenza è 30 minuti', CADENZA_MS === 30 * 60_000);

    console.log(`\nscansione-registri: ${p} passati, ${f} falliti`);
    if (require.main === module) process.exit(f === 0 ? 0 : 1);
  })();
  return true;
}

module.exports = { unioneMercati, scansiona, CADENZA_MS, selfcheck };

if (require.main === module) selfcheck();

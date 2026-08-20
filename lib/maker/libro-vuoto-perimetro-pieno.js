'use strict';
// lib/maker/libro-vuoto-perimetro-pieno.js — «PERIMETRO PIENO, LIBRO VUOTO» NON DEVE DURARE. PURO.
//
// ═══ LA REGOLA, decisione dell'operatore del 18 agosto 2026 ══════════════════════════════════════════
// «Sempre 1 mercato con ordini a libro. Quando un mercato finisce, un altro lo sostituisce SUBITO con
//  la coppia piazzata. Non deve esistere uno stato "perimetro pieno, libro vuoto" che dura piu' di un
//  ciclo.»
//
// ═══ IL FATTO CHE LA RENDE NECESSARIA ════════════════════════════════════════════════════════════════
// La sera del 18 agosto il bot ha passato **mezz'ora** con uno slot occupato e zero ordini al venue. La
// causa di quella volta era l'allocatore (la quota di coda lunga che senza fascia corta diventava un
// divieto) ed e' stata corretta a monte. Ma la CAUSA non e' il punto: uno slot occupato che non produce
// ordini e' inutile qualunque sia la ragione, e le ragioni possibili sono molte — un mercato che il
// piano non finanzia, un gate che rifiuta sempre, un book troppo sottile, una banda che si chiude.
// Questa regola non diagnostica: **misura l'esito** e libera lo slot perche' qualcun altro ci provi.
//
// ═══ PERCHE' DUE OSSERVAZIONI E NON UNA ══════════════════════════════════════════════════════════════
// Un mercato appena entrato non ha ancora ordini: fra la selezione e il piazzamento passa un ciclo per
// costruzione. Liberarlo alla prima osservazione vorrebbe dire non farlo entrare mai — un cane che si
// morde la coda, e la stessa forma del difetto che questa regola vuole chiudere. Due osservazioni
// CONSECUTIVE sono il minimo che distingue «non ha ancora avuto tempo» da «non ce la fa».
//
// ⚠ E «CONSECUTIVE» VUOL DIRE ANCHE CONTIGUE: oltre `MAX_INTERVALLO_MS` fra due osservazioni il
// contatore riparte. E' la stessa disciplina del guardiano delle perdite (§5-bis p.141): due letture
// lontane non descrivono uno stato che persiste, descrivono due istanti scollegati.
//
// ⚠ FAIL-CLOSED, e qui vuol dire NON LIBERARE: se la lista degli ordini vivi non e' leggibile non si
// sa se il libro sia vuoto, e liberare uno slot su un'ipotesi puo' cancellare gli ordini di un mercato
// che stava lavorando. L'assenza di una prova non e' la prova dell'assenza.
//
// ═══ ⚠⚠ «NESSUN ORDINE A LIBRO» HA DUE CAUSE OPPOSTE, E LA PRIMA STESURA NE VEDEVA UNA SOLA ══════════
// Decisione dell'operatore, sera del 18 agosto 2026, dopo che questa regola ha buttato fuori CINQUE
// VOLTE un mercato che andava benissimo (`0x17dfedcac2`, 20:49:54 · 20:55:54 · 21:03:24 · 21:05:24 ·
// 21:06:40, registro `maker-auto-reprice-audit.jsonl`).
//
// Le due cause:
//   · **STERILE** — non ci abbiamo mai messo capitale, o non ce lo possiamo mettere. Il piano non lo
//     finanzia, i gate lo rifiutano, il book e' irraggiungibile. Qui liberare lo slot e' giusto.
//   · **SVUOTATO DA NOI** — il capitale c'era e l'abbiamo tolto noi: il repricer ha cancellato per mid
//     stantio, l'erosione ha sospeso, una chiusura ha ritirato. Qui liberare lo slot e' SBAGLIATO, e lo
//     e' due volte: il mercato non ha nessuna colpa, e il successivo si comportera' identico perche' la
//     causa non sta nel mercato.
//
// Margine e raffreddamento NON bastano e non sono stati aggiunti al posto di questo: rallenterebbero la
// regola senza correggerla, cioe' butterebbero fuori lo stesso mercato con dieci minuti di ritardo.
//
// LA REGOLA: un'osservazione NON conta come sterile se in quel mercato ci sono stati **ordini nostri
// cancellati da noi** nella finestra osservata. E il contatore **si azzera a ogni piazzamento
// riuscito**: se siamo riusciti a metterci capitale, qualunque cosa sia successa prima non descrive
// piu' questo mercato.
//
// ⚠ NON TOCCA I MERCATI IN GESTIONE. Un mercato con una posizione aperta non ha piu' ordini di
// apertura per costruzione (la rotazione, §4.13): misurarlo con questo metro lo libererebbe sempre, e
// liberarlo non farebbe entrare nessuno — il suo slot e' gia' libero.
//
// ⚠ NON CANCELLA NIENTE E NON PIAZZA NIENTE. Restituisce un elenco di mercati da rilasciare; a
// rilasciare e' `rilasciaDallaSelezione`, che tocca `setAutoReprice` e nient'altro — quindi spegne
// l'INGRESSO, non l'uscita (§4.13). Un mercato senza ordini non ha nulla da cui uscire.

/** Due osservazioni piu' lontane di cosi' non sono contigue: l'orologio riparte. */
const MAX_INTERVALLO_MS = 300_000;   // 5 minuti — il ciclo che ospita questa decisione gira ogni 120 s

// ═══ LA SOGLIA E' IN MINUTI, E VIENE DAL VUOTO FRA DUE POPOLAZIONI — 20 agosto 2026 ═════════════════
//
// Fino a oggi la soglia era `OSSERVAZIONI = 2`, cioe' ~2-4 minuti. La misura di stasera (24 h, 1.439
// campioni, 43 episodi di occupazione) dice che quella taratura fa DANNO, e di quanto:
//
//   A · minuti dall'ingresso al PRIMO ordine, di chi HA piazzato (n=21):
//       0,0 0,0 0,0 1,0 2,0 2,0 2,0 2,0 2,0 3,0 7,0 7,0 8,0 8,8 9,0 11,0 11,0 · 33,0 · 102,1 · 119,1
//   B · minuti a zero ordini, di chi NON ha MAI piazzato (n=22):
//       5,8 7,9 13,0 13,0 16,0 24,0 25,0 25,9 28,0 28,0 54,9 … mediana 58,0 … max 372,2
//
// A 4 minuti si ucciderebbero **10 piazzamenti riusciti su 21 (48%)**: e' esattamente il danno per cui
// la regola e' stata DISARMATA il 18 agosto (§4.13), quando aveva buttato fuori cinque volte un
// mercato che andava benissimo. Riarmarla a quella taratura sarebbe rifare quel guasto.
//
// ⚠ LE DUE POPOLAZIONI SI SOVRAPPONGONO, quindi non esiste una soglia senza costo. Ma nella
// distribuzione A c'e' UN SOLO vuoto largo: **fra 11,0 e 33,0 minuti**, 22 minuti in cui non cade
// nessuna osservazione. Chi doveva piazzare l'ha fatto entro 11 minuti in 18 casi su 21; i tre oltre
// il vuoto (33, 102, 119) sono un'altra popolazione. Si sceglie DENTRO il vuoto, e si sceglie il suo
// punto medio — la stessa logica con cui l'85% del collasso di copertura fu scelto perche' il divario
// fra fisiologico e patologico era VUOTO (§5-bis p.142).
//
//   soglia = (11,0 + 33,0) / 2 = 22 minuti  ⇒  86% dei piazzamenti riusciti preservati,
//                                              1.711 minuti morti recuperati su 2.140.
const SOGLIA_MIN = 22;
const SOGLIA_MS = SOGLIA_MIN * 60_000;

// ═══ LA QUARANTENA — 180 MINUTI, E NON BASTA ═══════════════════════════════════════════════════════
//
// ⚠ SENZA QUARANTENA LA REGOLA OSCILLA, ed e' misurato: a soglia 22 min, `0x5e082f0b` sarebbe stato
// rilasciato **8 volte in 24 ore**, rientrando ogni volta perche' era ancora il miglior candidato
// rimasto. Gli intervalli fra rilascio e rientro misurati sono 18, 30, 34, 54, 100, 130, 352, 352 min.
//
// ⚠ E VA DETTO CHE 180 MINUTI NON SPENGONO L'OSCILLAZIONE, LA RIDUCONO: sopprimono 6 rientri su 8.
// Per sopprimerli tutti servirebbero oltre 352 minuti, cioe' piu' della vita utile di un mercato —
// non sarebbe una quarantena, sarebbe un bando. 180 e' la scelta dell'operatore fra i valori misurati
// (a 60 min i rilasci ripetuti su quel mercato restano 6 su 8, a 180 scendono a 2).
//
// ⚠ LA CAUSA VERA NON E' LO SLOT, E' IL BACINO: ammissibili in 24 h mediana 8, p25 7, min 4, e nel 25%
// dei cicli sono <= 6. Con 4 slot occupati il ricambio pesca fra ~4 alternative. La quarantena
// contiene il sintomo; la cura sta in quante alternative il board offre.
const QUARANTENA_MIN = 180;
const QUARANTENA_MS = QUARANTENA_MIN * 60_000;

// ═══ IL TETTO ORARIO ════════════════════════════════════════════════════════════════════════════════
// Dai 20 rilasci simulati in 24 h: media 0,83/ora, e il MASSIMO in una finestra scorrevole di 60
// minuti e' **4**. Il tetto e' 5, cioe' uno sopra il picco misurato: non morde mai su un'ora normale
// (nemmeno la piu' carica osservata), e ferma una tempesta — che a quel punto non e' piu' ricambio ma
// un ciclo impazzito. Oltre il tetto si SMETTE e si dichiara, non si rallenta in silenzio.
const TETTO_RILASCI_ORA = 5;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (x) => String(x == null ? '' : x).trim().toLowerCase();

/** Lo stato vuoto, per chi comincia. */
function statoVuoto() { return { zeroDa: {}, ultimaAt: null, quarantena: {}, rilasci: [] }; }

/**
 * @param {object} p
 * @param {Array<string>} p.attivi   i mercati che occupano uno slot (NON in gestione)
 * @param {{leggibile:boolean, ids:Array<string>}} p.ordini  i mercati con ordini a riposo al venue
 * @param {{leggibile:boolean, conditionIds?:Array<string>, ids?:Array<string>}} [p.posizioni]
 *        i mercati con una POSIZIONE aperta. FAIL-CLOSED: se non e' leggibile non si rilascia nessuno.
 * @param {object} p.stato   lo stato restituito dalla chiamata precedente
 * @param {number} p.ora
 * @param {Array<string>} [p.svuotatiDaNoi]       mercati dove NOI abbiamo cancellato: non conta
 * @param {Array<string>} [p.piazzatiConSuccesso] mercati dove un piazzamento e' riuscito: azzera
 * @returns {{azione:'nessuna'|'rilascia', daRilasciare:Array, motivo:string, statoNuovo:object,
 *            inQuarantena:Array<string>, tettoRaggiunto:boolean}}
 */
function valuta({ attivi, ordini, posizioni = null, stato, ora,
  svuotatiDaNoi = [], piazzatiConSuccesso = [] } = {}) {
  const S = (stato && typeof stato === 'object' && stato.zeroDa) ? stato : statoVuoto();
  let nonContateFuori = [];
  const quarantenaViva = () => Object.entries(S.quarantena || {})
    .filter(([, t]) => fin(t) && (ora - t) < QUARANTENA_MS).map(([id]) => id);
  const fermo = (motivo, statoNuovo) => ({
    azione: 'nessuna', daRilasciare: [], motivo, statoNuovo: statoNuovo || S,
    zeroDa: { ...(statoNuovo || S).zeroDa }, nonContate: nonContateFuori,
    inQuarantena: fin(ora) ? quarantenaViva() : [], tettoRaggiunto: false,
  });

  if (!fin(ora)) return fermo('orologio non leggibile: non si giudica una durata senza sapere che ora e\'');
  if (!Array.isArray(attivi)) return fermo('elenco dei mercati attivi non leggibile');
  if (!ordini || ordini.leggibile !== true) {
    // ⚠ NON si azzera l'orologio: «non ho letto» non e' «il libro si e' riempito». Si sospende il
    // giudizio e si riprende alla prossima lettura buona — prudenza, non amnesia.
    return fermo('ordini vivi non leggibili: non si libera uno slot su un\'ipotesi (fail-closed)');
  }
  // ⚠ REGOLA 9, FAIL-CLOSED E PRIMA DI TUTTO. Un mercato con una POSIZIONE aperta o una coppia
  // incompleta non si rilascia mai, a nessun netto. E se non si riesce a LEGGERE le posizioni non si
  // rilascia NESSUNO: rilasciare senza sapere chi ha una posizione e' esattamente il caso che la
  // regola 9 vieta, e l'assenza del dato non lo rende sicuro.
  if (!posizioni || posizioni.leggibile !== true) {
    return fermo('posizioni non leggibili: nessuno slot si libera senza sapere chi ha una posizione aperta (regola 9, fail-closed)');
  }

  // ── LA CONTIGUITA' ───────────────────────────────────────────────────────────────────────────────
  // Oltre `MAX_INTERVALLO_MS` fra due osservazioni non si puo' affermare che il libro sia stato vuoto
  // per TUTTO l'intervallo: l'orologio riparte da adesso invece di contare un buco che nessuno ha visto.
  const troppoLontano = fin(S.ultimaAt) && (ora - S.ultimaAt) > MAX_INTERVALLO_MS;
  const base = troppoLontano ? {} : (S.zeroDa || {});

  const conOrdini = new Set((Array.isArray(ordini.ids) ? ordini.ids : []).map(normId).filter(Boolean));
  const conPosizione = new Set(
    (Array.isArray(posizioni.conditionIds) ? posizioni.conditionIds
      : (Array.isArray(posizioni.ids) ? posizioni.ids : [])).map(normId).filter(Boolean),
  );
  const svuotati = new Set((Array.isArray(svuotatiDaNoi) ? svuotatiDaNoi : []).map(normId).filter(Boolean));
  const piazzati = new Set((Array.isArray(piazzatiConSuccesso) ? piazzatiConSuccesso : []).map(normId).filter(Boolean));
  const inQ = new Set(quarantenaViva());

  const zeroDa = {};
  const nonContate = [];
  const candidati = [];
  for (const raw of attivi) {
    const id = normId(raw);
    if (!id) continue;
    // ⚠ GLI INTOCCABILI, nell'ordine in cui la regola 9 li nomina. Nessuno di questi guarda il netto:
    // un occupante a −$99 con una posizione aperta resta dov'e' contro uno sfidante a +$50.
    if (conPosizione.has(id)) continue;              // posizione aperta / coppia incompleta
    if (conOrdini.has(id)) continue;                 // anche UN SOLO ordine vivo a libro
    if (piazzati.has(id)) continue;                  // ha appena piazzato: l'orologio sparisce
    if (svuotati.has(id)) {
      // Il libro e' vuoto perche' l'abbiamo svuotato NOI: non e' una prova di sterilita', e' la prova
      // del contrario. Si CONSERVA l'orologio invece di azzerarlo, cosi' un mercato davvero sterile
      // che ogni tanto riceve una cancellazione non riparte da zero all'infinito.
      const da = fin(base[id]) ? base[id] : null;
      if (da !== null) zeroDa[id] = da;
      nonContate.push({ id, daConservato: da, motivo: 'svuotato-da-noi',
        dettaglio: 'ordini nostri cancellati da noi in questa finestra: il libro e vuoto perche lo abbiamo svuotato, non perche il mercato sia sterile' });
      continue;
    }
    const da = fin(base[id]) ? base[id] : ora;
    zeroDa[id] = da;
    const minuti = (ora - da) / 60_000;
    if (minuti >= SOGLIA_MIN) candidati.push({ id, minuti: +minuti.toFixed(1), da });
  }

  // ── LA QUARANTENA, poi IL TETTO ─────────────────────────────────────────────────────────────────
  // Un mercato in quarantena non si rilascia di nuovo: e' gia' uscito da meno di `QUARANTENA_MIN` e
  // rilasciarlo un'altra volta e' il churn che la quarantena esiste per fermare.
  const bloccatiDaQuarantena = candidati.filter((c) => inQ.has(c.id));
  let daRilasciare = candidati.filter((c) => !inQ.has(c.id));

  // Il tetto guarda una finestra SCORREVOLE di 60 minuti, non l'ora solare: un ciclo impazzito a
  // cavallo di due ore passerebbe due volte sotto un tetto per ora solare.
  const recenti = (Array.isArray(S.rilasci) ? S.rilasci : []).filter((t) => fin(t) && (ora - t) < 3_600_000);
  const spazio = Math.max(0, TETTO_RILASCI_ORA - recenti.length);
  const tettoRaggiunto = daRilasciare.length > spazio;
  const troncati = tettoRaggiunto ? daRilasciare.slice(spazio) : [];
  daRilasciare = tettoRaggiunto ? daRilasciare.slice(0, spazio) : daRilasciare;

  const quarantenaNuova = { ...(S.quarantena || {}) };
  for (const c of daRilasciare) quarantenaNuova[c.id] = ora;
  for (const k of Object.keys(quarantenaNuova)) {
    if (!fin(quarantenaNuova[k]) || (ora - quarantenaNuova[k]) >= QUARANTENA_MS) delete quarantenaNuova[k];
  }
  const statoNuovo = { zeroDa, ultimaAt: ora, quarantena: quarantenaNuova,
    rilasci: [...recenti, ...daRilasciare.map(() => ora)] };
  nonContateFuori = nonContate;

  for (const c of daRilasciare) {
    c.motivo = 'slot-sterile';
    c.dettaglio = `occupa uno slot da ${c.minuti} minuti senza mai avere ordini a libro `
      + `(soglia ${SOGLIA_MIN} min): lo slot si libera perche un altro mercato possa provarci`;
  }

  const inQuarantenaFuori = Object.keys(quarantenaNuova);
  if (daRilasciare.length === 0) {
    const inAttesa = Object.keys(zeroDa).length;
    return {
      azione: 'nessuna', daRilasciare: [], statoNuovo, zeroDa: { ...zeroDa }, nonContate,
      inQuarantena: inQuarantenaFuori, tettoRaggiunto, troncati,
      bloccatiDaQuarantena,
      motivo: tettoRaggiunto
        ? `tetto di ${TETTO_RILASCI_ORA} rilasci/ora raggiunto: ${troncati.length} slot restano occupati e si dichiara`
        : (bloccatiDaQuarantena.length
          ? `${bloccatiDaQuarantena.length} slot sterili ma in quarantena da meno di ${QUARANTENA_MIN} min: non si rilasciano`
          : (inAttesa ? `${inAttesa} slot senza ordini, ma nessuno oltre i ${SOGLIA_MIN} minuti`
            : 'ogni slot occupato ha ordini a libro')),
    };
  }
  return {
    azione: 'rilascia', daRilasciare, statoNuovo, zeroDa: { ...zeroDa }, nonContate,
    inQuarantena: inQuarantenaFuori, tettoRaggiunto, troncati, bloccatiDaQuarantena,
    motivo: `${daRilasciare.length} slot occupati senza ordini a libro da ${SOGLIA_MIN}+ minuti`
      + (bloccatiDaQuarantena.length ? ` · ${bloccatiDaQuarantena.length} bloccati dalla quarantena` : '')
      + (tettoRaggiunto ? ` · ${troncati.length} oltre il tetto di ${TETTO_RILASCI_ORA}/ora` : ''),
  };
}

module.exports = { valuta, statoVuoto, MAX_INTERVALLO_MS,
  SOGLIA_MIN, SOGLIA_MS, QUARANTENA_MIN, QUARANTENA_MS, TETTO_RILASCI_ORA };

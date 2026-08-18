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
// ⚠ NON TOCCA I MERCATI IN GESTIONE. Un mercato con una posizione aperta non ha piu' ordini di
// apertura per costruzione (la rotazione, §4.13): misurarlo con questo metro lo libererebbe sempre, e
// liberarlo non farebbe entrare nessuno — il suo slot e' gia' libero.
//
// ⚠ NON CANCELLA NIENTE E NON PIAZZA NIENTE. Restituisce un elenco di mercati da rilasciare; a
// rilasciare e' `rilasciaDallaSelezione`, che tocca `setAutoReprice` e nient'altro — quindi spegne
// l'INGRESSO, non l'uscita (§4.13). Un mercato senza ordini non ha nulla da cui uscire.

/** Due osservazioni piu' lontane di cosi' non sono consecutive: il contatore riparte. */
const MAX_INTERVALLO_MS = 300_000;   // 5 minuti — il ciclo che ospita questa decisione gira ogni 120 s
/** Quante osservazioni consecutive servono per dichiarare uno slot sterile. */
const OSSERVAZIONI = 2;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (x) => String(x == null ? '' : x).trim().toLowerCase();

/** Lo stato vuoto, per chi comincia. */
function statoVuoto() { return { conteggi: {}, ultimaAt: null }; }

/**
 * @param {object} p
 * @param {Array<string>} p.attivi           i mercati che occupano uno slot (NON in gestione)
 * @param {{leggibile:boolean, ids:Array<string>}} p.ordini  i mercati con ordini a riposo al venue
 * @param {object} p.stato                   lo stato restituito dalla chiamata precedente
 * @param {number} p.ora
 * @returns {{azione:'nessuna'|'rilascia', daRilasciare:Array, motivo:string, statoNuovo:object,
 *            conteggi:object}}
 */
function valuta({ attivi, ordini, stato, ora } = {}) {
  const S = (stato && typeof stato === 'object' && stato.conteggi) ? stato : statoVuoto();
  const fermo = (motivo, statoNuovo) => ({
    azione: 'nessuna', daRilasciare: [], motivo, statoNuovo: statoNuovo || S, conteggi: { ...(statoNuovo || S).conteggi },
  });

  if (!fin(ora)) return fermo('orologio non leggibile: non si giudica una durata senza sapere che ora e\'');
  if (!Array.isArray(attivi)) return fermo('elenco dei mercati attivi non leggibile');
  if (!ordini || ordini.leggibile !== true) {
    // ⚠ NON si azzera il contatore: «non ho letto» non e' «il libro si e' riempito». Si sospende il
    // giudizio e si riprende alla prossima lettura buona, che e' la differenza fra prudenza e amnesia.
    return fermo('ordini vivi non leggibili: non si libera uno slot su un\'ipotesi (fail-closed)');
  }

  // ── LA CONTIGUITA' ───────────────────────────────────────────────────────────────────────────────
  const troppoLontano = fin(S.ultimaAt) && (ora - S.ultimaAt) > MAX_INTERVALLO_MS;
  const base = troppoLontano ? {} : (S.conteggi || {});

  const conOrdini = new Set((Array.isArray(ordini.ids) ? ordini.ids : []).map(normId).filter(Boolean));
  const conteggi = {};
  const daRilasciare = [];
  for (const raw of attivi) {
    const id = normId(raw);
    if (!id) continue;
    if (conOrdini.has(id)) continue;                 // ha ordini: il contatore sparisce, non si porta dietro niente
    const n = (fin(base[id]) ? base[id] : 0) + 1;
    conteggi[id] = n;
    if (n >= OSSERVAZIONI) {
      daRilasciare.push({
        id, osservazioni: n,
        motivo: 'slot-sterile',
        dettaglio: `occupa uno slot da ${n} osservazioni consecutive senza mai avere ordini a libro: `
          + 'lo slot si libera perche un altro mercato possa provarci',
      });
    }
  }

  const statoNuovo = { conteggi, ultimaAt: ora };
  if (daRilasciare.length === 0) {
    const inAttesa = Object.entries(conteggi).filter(([, n]) => n > 0).length;
    return fermo(inAttesa
      ? `${inAttesa} slot senza ordini, ma non ancora ${OSSERVAZIONI} osservazioni consecutive`
      : 'ogni slot occupato ha ordini a libro', statoNuovo);
  }
  return {
    azione: 'rilascia', daRilasciare, statoNuovo, conteggi: { ...conteggi },
    motivo: `${daRilasciare.length} slot occupati senza ordini a libro da ${OSSERVAZIONI}+ osservazioni consecutive`,
  };
}

module.exports = { valuta, statoVuoto, MAX_INTERVALLO_MS, OSSERVAZIONI };

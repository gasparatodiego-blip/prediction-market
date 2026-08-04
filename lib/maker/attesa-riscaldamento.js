'use strict';
// lib/maker/attesa-riscaldamento.js — LA RETE DI SICUREZZA SOPRA L'UNIONE MOBILE.
//
// ═══ PERCHÉ ESISTE, E PERCHÉ NASCE SPENTA ═══════════════════════════════════════════════════════════
// L'unione mobile (lib/rewards/collector-priority) tiene caldi i mercati che il piano ha scelto o
// quasi-scelto nelle ultime ore. Copre il caso normale — un mercato che entra ed esce dalla graduatoria —
// ma NON può coprire il caso limite: un mercato che entra nel piano senza essere MAI stato né riga né
// quasi-vincitore in nessuna delle scritture precedenti. Per quel mercato la lista si scrive troppo tardi:
// agent34 la legge alla riconciliazione dopo (fino a ~21 minuti) e servono uno o due campioni da 75s
// perché il dato sia fresco. Il ciclo che l'ha scelto lo trova comunque stantio, e lo scarta.
//
// Questa è la rete sotto quel caso: se il piano appena calcolato ha righe scartate PER DATO STANTIO — e
// solo per quello — si aspetta che il raccoglitore le riscaldi e si ricalcola, invece di piazzare su un
// piano dimezzato.
//
// Nasce SPENTA (ATTESA_RISCALDAMENTO_ENABLED assente ⇒ disattivata) perché il costo non è nullo e non è
// solo tempo di CPU: in modalità live ritarda di parecchi minuti un reset che il trigger di validità ha
// già giudicato urgente — e un reset urgente lo è spesso perché dei mercati si sono RISOLTI, cioè ci sono
// ordini appesi a qualcosa che non esiste più. Aspettare per piazzare meglio va deciso da chi opera,
// non da questo modulo.
//
// ═══ COSA NON FA ════════════════════════════════════════════════════════════════════════════════════
// Non abbassa mai il guard di freschezza: aspettare significa aspettare un dato VERO, non accontentarsi
// di uno vecchio. Non aspetta per righe scartate per altri motivi (fuori banda, senza bid, senza size):
// quelli non li guarisce il tempo. Non aspetta se non c'è niente da guadagnare. E se allo scadere
// dell'attesa il dato non è arrivato, restituisce il MIGLIORE fra i piani visti e lo dice — mai un piano
// peggiore di quello di partenza solo perché è più recente.

const MAX_MS = 25 * 60_000;   // ~21 minuti fra due riconciliazioni di agent34, più due campioni da 75s
const POLL_MS = 3 * 60_000;   // un ricalcolo del piano costa ~20s di CPU: non ha senso più fitto di così

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Quante righe questo esito ha scartato per DATO STANTIO — l'unico motivo che il tempo può guarire. */
function righeStantie(esec) {
  return ((esec && esec.scartate) || []).filter((x) => x && x.motivo === 'stantio');
}

/** Quanto capitale mette al lavoro un esito. È il metro con cui si sceglie fra due piani. */
const impegnato = (esec) => (esec && esec.totals && fin(esec.totals.capitaleUsd) ? esec.totals.capitaleUsd : 0);

/**
 * Aspetta che il raccoglitore riscaldi le righe stantie, ricalcolando il piano ogni pollMs.
 * Funzione pura rispetto al mondo: piano, orologio e attesa arrivano tutti da deps.
 *
 * @param {object} args  piano/esec di partenza, capitale e tetto con cui ricalcolare
 * @param {object} deps  makePlan({capital,maxPerMarketUsd}), planToOrders(piano,{nowMs}), sleep(ms), now(), traccia(fase,evento,dati)
 * @returns {{atteso, esito, tentativi, attesaMs, piano, esec, stantieIniziali, stantieFinali}}
 *          esito ∈ 'niente-da-attendere' | 'risolto' | 'scaduto' | 'ricalcolo-fallito' | 'disattivata'
 */
async function attendiRiscaldamento(
  { piano, esec, capitale, tetto, enabled = false, maxMs = MAX_MS, pollMs = POLL_MS } = {},
  deps = {},
) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const traccia = typeof deps.traccia === 'function' ? deps.traccia : () => {};
  const base = { atteso: false, tentativi: 0, attesaMs: 0, piano, esec, stantieIniziali: righeStantie(esec).length };

  if (!enabled) return { ...base, esito: 'disattivata', stantieFinali: base.stantieIniziali };
  if (base.stantieIniziali === 0) return { ...base, esito: 'niente-da-attendere', stantieFinali: 0 };

  const t0 = now();
  traccia('riscaldamento', 'atteso', {
    motivo: `${base.stantieIniziali} righe del piano hanno dato stantio: si aspetta che il raccoglitore le copra invece di piazzare su un piano dimezzato`,
    righe: righeStantie(esec).map((x) => `${String(x.marketId).slice(0, 10)}… ${x.dettaglio || ''}`.trim()),
    attesaMassimaMin: Math.round(maxMs / 60_000),
    capitaleImpegnatoOra: impegnato(esec),
  });

  let miglior = { piano, esec };
  let tentativi = 0;

  while (now() - t0 < maxMs) {
    const restante = maxMs - (now() - t0);
    await sleep(Math.min(pollMs, restante));
    tentativi += 1;

    let p2, e2;
    try {
      p2 = await deps.makePlan({ capital: capitale, maxPerMarketUsd: tetto });
      e2 = deps.planToOrders(p2, { nowMs: now() });
    } catch (e) {
      traccia('riscaldamento', 'ricalcolo-fallito', { tentativo: tentativi, error: e.message });
      return { ...base, atteso: true, tentativi, attesaMs: now() - t0, esito: 'ricalcolo-fallito', piano: miglior.piano, esec: miglior.esec, stantieFinali: righeStantie(miglior.esec).length };
    }

    // Si tiene il piano che mette al lavoro DI PIÙ, non il più recente: un ricalcolo può capitare in un
    // momento peggiore del primo, e in quel caso il tempo speso non deve nemmeno costare capitale.
    if (impegnato(e2) > impegnato(miglior.esec)) miglior = { piano: p2, esec: e2 };

    const stantie = righeStantie(e2).length;
    traccia('riscaldamento', 'ricalcolato', {
      tentativo: tentativi, stantie,
      capitaleImpegnatoUsd: impegnato(e2),
      migliorFinora: impegnato(miglior.esec),
      trascorsoMin: +((now() - t0) / 60_000).toFixed(1),
    });

    if (stantie === 0) {
      return { ...base, atteso: true, tentativi, attesaMs: now() - t0, esito: 'risolto', piano: p2, esec: e2, stantieFinali: 0 };
    }
  }

  const finali = righeStantie(miglior.esec).length;
  traccia('riscaldamento', 'scaduto', {
    tentativi, attesaMin: Math.round((now() - t0) / 60_000), stantieResidue: finali,
    capitaleImpegnatoUsd: impegnato(miglior.esec),
    motivo: 'il dato non e arrivato entro l attesa: si procede con il miglior piano visto, non con uno stantio spacciato per fresco',
  });
  return { ...base, atteso: true, tentativi, attesaMs: now() - t0, esito: 'scaduto', piano: miglior.piano, esec: miglior.esec, stantieFinali: finali };
}

module.exports = { attendiRiscaldamento, righeStantie, MAX_MS, POLL_MS };

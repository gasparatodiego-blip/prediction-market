'use strict';
// lib/maker/guardian-perdite.js — LA DECISIONE DEL GUARDIANO DELLE PERDITE, SENZA I/O.
//
// ═══ COSA SORVEGLIA, E PERCHÉ NON È agent37 ══════════════════════════════════════════════════════════
// agent37 sorveglia se un MOTORE È VIVO: battito fermo ⇒ i suoi ordini restano soli sul venue, e vanno
// tolti. È una domanda sulla salute dei processi, e la risposta non guarda un solo dollaro.
//
// Questo guarda l'altra cosa, quella che agent37 non può vedere: un motore perfettamente vivo, che batte
// regolare, e che sta perdendo soldi. Nessun battito manca, nessun processo muore, e il capitale scende.
// Sono due guasti indipendenti — e quindi due guardiani, non uno con due compiti.
//
// ═══ PERCHÉ È PURO ═══════════════════════════════════════════════════════════════════════════════════
// Questa funzione decide se cancellare ordini VERI e fermare il bot. Una decisione così deve poter essere
// esercitata per intero — soglie, confini, casi illeggibili — senza una rete, senza un orologio e senza
// toccare lo stato del guardiano in esecuzione. Tutto l'I/O sta in agents/agent43-guardian.js.
//
// ═══ LA REGOLA CHE CONTA PIÙ DELLE SOGLIE ════════════════════════════════════════════════════════════
// NON SI SCATTA SU UN NUMERO CHE NON SI È LETTO. Se il saldo non è leggibile, o lo snapshot delle
// posizioni è vecchio, il capitale attuale è `null` — e `null` NON è zero. Un saldo illeggibile
// interpretato come 0 produce «perdita del 100%», cioè uno scatto a piena forza causato da un errore di
// rete: il guardiano svuoterebbe il libro proprio nel momento in cui è più cieco.
//
// Questa è la direzione OPPOSTA a quella del kill-switch, e la differenza è voluta. Il kill fallisce
// CHIUSO (illeggibile ⇒ killed) perché la sua azione è NON FARE: nel dubbio, non piazzare, e il costo del
// dubbio è un'occasione persa. Qui l'azione è FARE — cancellare tutto e fermare il bot — e il costo del
// dubbio sarebbe un libro distrutto per un RPC lento. Un guardiano che nel dubbio agisce non è prudente:
// è un generatore di falsi allarmi con accesso al venue.

// ── L'ASSENZA NON SI TRAVESTE DA NUMERO ─────────────────────────────────────────────────────────────
// `Number(null)` è 0, `Number('')` è 0, `Number(false)` è 0. Tre valori ASSENTI che passano
// `Number.isFinite` come se fossero misure. Qui è il difetto più pericoloso possibile: un saldo
// illeggibile letto come 0 dollari significa «perdita del 100% del baseline», cioè uno scatto a piena
// forza — spazzata di tutto il libro e bot fermato — causato da un RPC lento.
//
// La prima stesura di questo file usava `Number.isFinite(Number(x))` e faceva esattamente questo. L'ha
// trovato il test, non una rilettura. La stessa trappola è documentata in cancel-all.notionalResiduoUsd,
// e questo helper è la stessa risposta: un valore assente resta NaN e propaga `null`.
const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));

/** Il totale in dollari, o `null` se anche un solo pezzo non è leggibile. Mai uno zero di ripiego. */
function valutaCapitale({ saldoUsd = null, posizioni = null, posizioniLeggibili = true } = {}) {
  const motivi = [];
  const s = num(saldoUsd);
  const saldo = Number.isFinite(s) ? s : null;
  if (saldo === null) motivi.push('saldo pUSD non leggibile');

  // Lo snapshot vecchio NON è «nessuna posizione»: è «non ho guardato». Se chi lo scrive (agent40) si
  // ferma, il guardiano deve accorgersene, non ereditare un elenco vuoto e concluderne che il capitale
  // in posizione sia sparito — che sarebbe, di nuovo, una perdita inventata.
  if (posizioniLeggibili !== true) motivi.push('snapshot delle posizioni non leggibile o troppo vecchio');

  let valorePosizioni = 0;
  const dettaglio = [];
  if (posizioniLeggibili === true && Array.isArray(posizioni)) {
    for (const p of posizioni) {
      const size = num(p && p.size);
      // `curPrice` assente è un prezzo che non abbiamo. Una posizione senza prezzo non vale zero
      // dollari: rende sconosciuto il totale, esattamente come in notionalResiduoUsd di cancel-all.
      const prezzo = num(p && p.curPrice);
      if (!Number.isFinite(size) || !Number.isFinite(prezzo)) {
        motivi.push(`posizione ${(p && p.tokenId) ? String(p.tokenId).slice(0, 12) + '…' : '(senza id)'} senza prezzo corrente`);
        valorePosizioni = null;
        break;
      }
      const v = size * prezzo;
      valorePosizioni += v;
      dettaglio.push({ tokenId: String((p && p.tokenId) || ''), conditionId: (p && p.conditionId) || null, size, curPrice: prezzo, valoreUsd: +v.toFixed(6) });
    }
  } else if (posizioniLeggibili === true) {
    // Leggibile e senza array = nessuna posizione aperta. Questo zero è REALE: abbiamo guardato.
    valorePosizioni = 0;
  } else {
    valorePosizioni = null;
  }

  const leggibile = saldo !== null && valorePosizioni !== null;
  return {
    leggibile,
    totaleUsd: leggibile ? +(saldo + valorePosizioni).toFixed(6) : null,
    saldoUsd: saldo,
    valorePosizioniUsd: valorePosizioni === null ? null : +valorePosizioni.toFixed(6),
    posizioni: dettaglio,
    motivo: leggibile ? null : motivi.join(' · '),
  };
}

/**
 * PnL assoluto e percentuale rispetto al baseline.
 * `null` in ingresso ⇒ `null` in uscita: non si calcola una percentuale su un numero non letto.
 */
function calcolaPnl({ baselineUsd = null, totaleUsd = null } = {}) {
  // Stesso helper, stessa ragione: un baseline `null` letto come 0 renderebbe ogni capitale positivo un
  // guadagno infinito, e un totale `null` letto come 0 una perdita totale.
  const b = num(baselineUsd); const t = num(totaleUsd);
  const base = Number.isFinite(b) ? b : null;
  const tot = Number.isFinite(t) ? t : null;
  if (base === null || tot === null) {
    return { calcolabile: false, pnlUsd: null, pnlPct: null, motivo: base === null ? 'baseline assente' : 'capitale attuale non leggibile' };
  }
  const pnlUsd = +(tot - base).toFixed(6);
  // Un baseline di zero (o negativo) non ammette una percentuale. Non è un caso teorico: sarebbe il
  // wallet svuotato, ed è proprio il momento in cui una divisione per zero produrrebbe Infinity e un
  // confronto con la soglia darebbe «vero» per ragioni aritmetiche invece che economiche.
  const pnlPct = base > 0 ? +((pnlUsd / base) * 100).toFixed(6) : null;
  return { calcolabile: true, pnlUsd, pnlPct, motivo: base > 0 ? null : 'baseline non positivo: la percentuale non è definita, resta il valore assoluto' };
}

/**
 * Scatta o no, e per quale delle due soglie. BASTA UNA delle due.
 *
 * Entrambe si esprimono come numeri POSITIVI nella configurazione (5 = «meno 5 per cento», 30 = «meno
 * trenta dollari») perché è così che si scrivono in un .env senza sbagliare un segno. Il confronto usa
 * il negativo, una volta sola e qui.
 */
function decidiScatto({ pnl = null, sogliaPct = 5, sogliaAbs = 30 } = {}) {
  if (!pnl || pnl.calcolabile !== true) {
    return { scatta: false, soglieSuperate: [], motivo: `nessuna decisione: ${(pnl && pnl.motivo) || 'PnL non calcolabile'} — non si scatta su un numero che non si è letto` };
  }
  const limPct = Math.abs(Number(sogliaPct));
  const limAbs = Math.abs(Number(sogliaAbs));
  const soglieSuperate = [];
  if (Number.isFinite(limPct) && pnl.pnlPct !== null && pnl.pnlPct <= -limPct) {
    soglieSuperate.push({ soglia: 'percentuale', limite: -limPct, valore: pnl.pnlPct, unita: '%' });
  }
  if (Number.isFinite(limAbs) && pnl.pnlUsd !== null && pnl.pnlUsd <= -limAbs) {
    soglieSuperate.push({ soglia: 'assoluta', limite: -limAbs, valore: pnl.pnlUsd, unita: 'USD' });
  }
  const scatta = soglieSuperate.length > 0;
  return {
    scatta,
    soglieSuperate,
    motivo: scatta
      ? `superate: ${soglieSuperate.map((s) => `${s.soglia} (${s.valore}${s.unita} ≤ ${s.limite}${s.unita})`).join(' e ')}`
      : `entro le soglie: PnL ${pnl.pnlUsd} USD${pnl.pnlPct === null ? '' : ` (${pnl.pnlPct}%)`}, limiti −${limAbs} USD / −${limPct}%`,
  };
}

/**
 * Il baseline è il punto zero. Sopravvive ai riavvii DI PROPOSITO.
 *
 * Un guardiano che ricalcola il baseline a ogni avvio non protegge da niente: se muore e rinasce (e un
 * processo che sorveglia le perdite è esattamente quello che un crash-loop può colpire), ogni rinascita
 * azzera la misura e la perdita accumulata sparisce. Sarebbe una soglia che si sposta sempre sotto i
 * piedi di chi cade. Si riparte da capo SOLO se l'operatore cancella il file a mano.
 */
function baselineDaScrivere({ capitale, now, motivo = 'primo avvio' }) {
  return {
    v: 1,
    at: now,
    atIso: new Date(now).toISOString(),
    motivo,
    baselineUsd: capitale.totaleUsd,
    saldoUsd: capitale.saldoUsd,
    valorePosizioniUsd: capitale.valorePosizioniUsd,
    posizioni: capitale.posizioni,
  };
}

/** Un baseline scritto è valido solo se porta un numero utilizzabile. Un file rotto = nessun baseline. */
function leggiBaseline(raw) {
  if (!raw || typeof raw !== 'object') return { valido: false, baselineUsd: null, motivo: 'baseline assente' };
  const v = num(raw.baselineUsd);
  if (!Number.isFinite(v)) return { valido: false, baselineUsd: null, motivo: 'baseline presente ma senza un valore numerico: va ricreato' };
  const at = num(raw.at);
  return { valido: true, baselineUsd: v, at: Number.isFinite(at) ? at : null, atIso: raw.atIso || null, motivo: null };
}

/**
 * Il referto dello scatto, con reason='guardian-auto-kill'.
 *
 * COSTRUITO SOPRA `costruisciCancellazione`, non accanto: la parte «quanti ordini, su quanti mercati,
 * quanto capitale liberato, quali venue» è identica a quella del dead-man e deve restare UNA forma sola,
 * altrimenti la dashboard che la legge dovrebbe imparare due dialetti. Cambiano `id` e `reason` — così i
 * due guardiani restano distinguibili nello stesso registro e nessuno sovrascrive l'altro — e si
 * aggiungono i numeri che solo questo guardiano conosce.
 */
function costruisciEventoGuardian({ base, at, pnl, capitale, baseline, soglieSuperate, sogliaPct, sogliaAbs, botFermato }) {
  return {
    ...base,
    id: `guardian-${at}`,
    reason: 'guardian-auto-kill',
    // I campi del dead-man che qui non hanno senso restano null invece di portare un numero preso a
    // prestito: questo guardiano non misura un battito.
    stalenessSec: null,
    thresholdSec: null,
    oltreSogliaSec: null,
    heartbeatAt: null,
    guardian: {
      pnlUsd: pnl.pnlUsd,
      pnlPct: pnl.pnlPct,
      baselineUsd: baseline.baselineUsd,
      baselineAt: baseline.atIso || null,
      totaleAttualeUsd: capitale.totaleUsd,
      saldoUsd: capitale.saldoUsd,
      valorePosizioniUsd: capitale.valorePosizioniUsd,
      soglieSuperate,
      sogliaPct: -Math.abs(sogliaPct),
      sogliaAbs: -Math.abs(sogliaAbs),
      // Quale delle due, in una parola, per chi legge di fretta alle quattro del mattino.
      scattataPer: soglieSuperate.length === 2 ? 'entrambe' : (soglieSuperate[0] ? soglieSuperate[0].soglia : null),
      botFermato,
      posizioniAlloScatto: capitale.posizioni,
    },
  };
}

// ══ IL LATCH SCADE, E NON SI FIDA DI SE STESSO ═══════════════════════════════════════════════════════
// Decisione dell'operatore, 12 agosto 2026.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// Il latch era, dal punto di vista di chi lo LEGGE, un booleano: `stato.scattato === true` ⇒ «già
// scattato», e da lì agent43 usciva senza guardare altro. Il file portava anche il P&L e il baseline
// dello scatto, ma nessuno li rileggeva — quindi un latch scattato il 9 agosto teneva il guardiano fuori
// servizio il 12, con il P&L tornato a **+$2,54 su soglie −$30 / −5%**. Cioè: nel momento in cui il
// capitale era sano, nessuno lo sorvegliava.
//
// «Nessun auto-riarmo» era la regola giusta per l'ISTANTE dello scatto — un guardiano che si riarma da
// solo dopo trenta secondi litiga con la persona che lo sta riarmando — ma non per SEMPRE. Un latch
// senza scadenza smette di essere una protezione e diventa un interruttore spento.
//
// ═══ LA REGOLA ═══════════════════════════════════════════════════════════════════════════════════════
// Ogni giro si rivaluta dal P&L CORRENTE invece di fidarsi del flag, e un latch si azzera da solo
// quando valgono ENTRAMBE:
//   · è più vecchio di `ETA_RIARMO_MS` (24 ore), e
//   · il P&L corrente è SOPRA soglia (cioè il guardiano, misurando adesso, non scatterebbe).
// Manca una delle due ⇒ resta scattato. In particolare un latch vecchio con P&L ancora sotto soglia
// NON si azzera: il tempo da solo non guarisce una perdita.
//
// ═══ COSA NON CAMBIA ═════════════════════════════════════════════════════════════════════════════════
// Lo scatto resta immediato e resta duro. Le 24 ore non sono un ritardo dello scatto: sono la finestra
// oltre la quale un latch **già scattato e già rientrato** smette di valere. E l'azzeramento non riavvia
// il bot: `maker-bot-enabled` resta dov'è: rimettere su AVVIA è e resta una decisione dell'operatore.
//
// ═══ FAIL-CLOSED ═════════════════════════════════════════════════════════════════════════════════════
// P&L non misurabile ⇒ NON si azzera. «Non so quanto sto perdendo» non è «non sto perdendo», ed è
// esattamente il caso in cui un guardiano deve restare dov'è.

const ETA_RIARMO_MS = 24 * 3_600_000;

/**
 * IL LATCH VA ANCORA TENUTO? Pura.
 *
 * @param a.stato      il contenuto di `data/guardian-state.json` (`null` = nessun latch)
 * @param a.pnl        il P&L CORRENTE da `calcolaPnl` (`null`/non misurabile ⇒ non si azzera)
 * @param a.sogliaPct  le soglie in vigore, lette adesso
 * @returns {{tieni:boolean, azzera:boolean, etaMs:number|null, motivo:string}}
 */
function valutaLatch({ stato = null, pnl = null, sogliaPct = 5, sogliaAbs = 30,
  now = Date.now(), etaRiarmoMs = ETA_RIARMO_MS } = {}) {
  if (!stato || stato.scattato !== true) {
    return { tieni: false, azzera: false, etaMs: null, motivo: 'nessun latch: il guardiano è in servizio' };
  }
  const at = Number(stato.at);
  // Un latch senza istante non si può far scadere: si tiene. È la direzione sicura, e dice quale
  // campo manca invece di comportarsi come se fosse appena scattato.
  if (!Number.isFinite(at)) {
    return { tieni: true, azzera: false, etaMs: null,
      motivo: "latch senza istante di scatto (`at` non leggibile): non si puo' valutarne l'eta', resta scattato" };
  }
  const etaMs = now - at;
  const ore = etaMs / 3_600_000;
  if (etaMs < etaRiarmoMs) {
    return { tieni: true, azzera: false, etaMs,
      motivo: `latch scattato ${ore.toFixed(1)}h fa, sotto le ${(etaRiarmoMs / 3_600_000).toFixed(0)}h di scadenza: resta scattato` };
  }
  // ── OLTRE LE 24 ORE: DECIDE IL P&L DI ADESSO, NON QUELLO DELLO SCATTO ──────────────────────────
  if (!pnl || pnl.calcolabile !== true) {
    return { tieni: true, azzera: false, etaMs,
      motivo: `latch vecchio di ${ore.toFixed(1)}h, ma il P&L corrente non è misurabile: non si azzera al buio` };
  }
  const scatto = decidiScatto({ pnl, sogliaPct, sogliaAbs });
  if (scatto.scatta) {
    return { tieni: true, azzera: false, etaMs,
      motivo: `latch vecchio di ${ore.toFixed(1)}h, ma il P&L corrente è ANCORA sotto soglia`
        + ` (${pnl.pnlUsd.toFixed(2)} USD / ${pnl.pnlPct === null ? '?' : pnl.pnlPct.toFixed(3)}%): il tempo non guarisce una perdita` };
  }
  return { tieni: false, azzera: true, etaMs,
    motivo: `latch vecchio di ${ore.toFixed(1)}h e P&L corrente SOPRA soglia`
      + ` (${pnl.pnlUsd >= 0 ? '+' : ''}${pnl.pnlUsd.toFixed(2)} USD`
      + `${pnl.pnlPct === null ? '' : ` / ${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct.toFixed(3)}%`}`
      + ` contro −${sogliaAbs} USD / −${sogliaPct}%): si azzera e il guardiano torna in servizio` };
}

/** Il referto dell'azzeramento, per l'audit. Dichiara il PRIMA e il DOPO, non solo l'esito. */
function eventoRiarmo({ stato, pnl, etaMs, motivo, at }) {
  return {
    ts: at, venue: 'polymarket', source: 'agent43-guardian', op: 'guardian',
    outcome: 'latch-azzerato-per-scadenza',
    reason: motivo,
    observed: {
      latchDa: stato && stato.atIso ? stato.atIso : null,
      etaOre: Number.isFinite(etaMs) ? +(etaMs / 3_600_000).toFixed(2) : null,
      pnlAlloScatto: stato ? stato.pnlUsd : null,
      pnlPctAlloScatto: stato ? stato.pnlPct : null,
      pnlAdesso: pnl ? pnl.pnlUsd : null,
      pnlPctAdesso: pnl ? pnl.pnlPct : null,
      baselineUsd: pnl && pnl.baselineUsd != null ? pnl.baselineUsd : null,
      totaleUsd: pnl && pnl.totaleUsd != null ? pnl.totaleUsd : null,
      // ⚠ L'AZZERAMENTO NON RIMETTE IL BOT SU AVVIA, e va detto qui perché è la riga che qualcuno
      // leggerà per capire cosa è successo: torna in servizio il GUARDIANO, non il motore.
      botRiavviato: false,
    },
  };
}

module.exports = {
  valutaLatch, eventoRiarmo, ETA_RIARMO_MS,
  valutaCapitale, calcolaPnl, decidiScatto, baselineDaScrivere, leggiBaseline, costruisciEventoGuardian,
};

'use strict';
// lib/maker/trigger-capitale-fermo.js — IL CAPITALE FERMO NON ASPETTA SEI ORE.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Il riallocatore gira ogni 6 ore. Quando un merge o una chiusura liberano collaterale — cosa che
// avviene quando capita, non ogni sei ore — quel denaro resta fermo fino al giro successivo. Nel caso
// peggiore sono sei ore di capitale che non matura niente, su un conto da qualche centinaio di dollari
// dove ogni ordine vale ~$34-37: sei ore di un intero ordine spento.
//
// ═══ COSA FA, E COSA DELIBERATAMENTE NON FA ═════════════════════════════════════════════════════════
// Sorveglia il saldo pUSD LIQUIDO. Quando supera la soglia, NON ricalcola il piano — quel calcolo costa
// ~52 secondi e porta il processo a 687 MB contro un tetto pm2 di 400, ed è la ragione per cui il piano
// vive in un processo figlio. Fa invece un MINI-CICLO: prende il mercato migliore che l'ULTIMO piano
// aveva già scelto e gli rimette sopra il capitale liberato.
//
//   · NON cancella NIENTE. Mai. È l'unica azione che questo percorso non conosce, ed è anche la
//     risposta strutturale alla domanda «e gli ordini messi a mano?»: non li tocca perché non tocca
//     nessun ordine esistente, di nessuna origine. Aggiunge e basta.
//   · NON sceglie mercati nuovi. Sceglie fra quelli che il piano pesante aveva già valutato e ammesso:
//     la reattività non è una scusa per saltare la selezione.
//   · NON forza un piazzamento. Se nessun mercato ha spazio, o se lo spazio è troppo piccolo per un
//     ordine sensato, il capitale resta liquido e si riprova al giro dopo. Un ordine piazzato per non
//     restare fermi è un ordine che nessuno ha deciso.
//
// ═══ PERCHÉ «SALDO pUSD» È LA MISURA GIUSTA ═════════════════════════════════════════════════════════
// Su questo venue un ordine BUY a riposo IMMOBILIZZA il collaterale: finché l'ordine è sul libro, quei
// dollari non sono nel saldo. Quindi il saldo pUSD libero È, per costruzione, il capitale non allocato —
// non serve dedurlo sottraendo gli ordini, e dedurlo sarebbe peggio, perché due letture separate
// possono divergere. Quando un merge o una chiusura liberano collaterale, il saldo sale: è esattamente
// il segnale che questo modulo aspetta.
//
// ═══ DOVE VA IL CAPITALE, E PERCHÉ PROPRIO LÌ ═══════════════════════════════════════════════════════
// Non «sul mercato col punteggio più alto» in astratto: sul mercato dove il piano aveva messo capitale
// e adesso ne ha meno del previsto. È la definizione operativa di «capitale liberato»: se una chiusura
// ha svuotato il mercato X, X torna ad avere spazio sotto il tetto che il piano gli aveva assegnato, e
// il mini-ciclo lo riempie. Così il trigger riporta il portafoglio verso il piano invece di inventarne
// uno nuovo — che è il mestiere del ciclo a sei ore, non suo.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * LA SOGLIA. Decisa dall'operatore l'8 agosto 2026: $50 di capitale liquido fermo.
 * Il perché è la size tipica di un ordine su questo conto — il consensus misurato sui 21 maker di
 * riferimento dà un nozionale mediano di ~$34 ($16-74, data/manuale-operativo-maker-v2.md). Con $50
 * liberi c'è spazio per un ordine intero e un margine; sotto, si starebbe piazzando un residuo.
 */
const SOGLIA_USD = Number(process.env.TRIGGER_CAPITALE_SOGLIA_USD || 50);

/**
 * LA CADENZA. 120 secondi, e non è un numero tondo scelto a caso:
 *   · la cache del saldo (lib/maker/saldo-cache) ha TTL 45s, quindi sotto i 45s si rileggerebbe lo
 *     stesso valore — polling che costa e non informa. 120s sono 2,7 TTL: ogni giro vede un valore
 *     che può essere cambiato davvero.
 *   · il costo è una chiamata HTTP al dashboard locale (che a sua volta usa la cache): 720 al giorno,
 *     invisibili accanto ai 22.602 polling di ordini che agent40 fa già.
 *   · la reattività: nel caso peggiore 2 minuti fra il merge e il reimpiego, contro le 6 ore di prima.
 * La lettura del VENUE (ordini a riposo) NON avviene a ogni giro: solo quando la soglia è già superata.
 */
const CADENZA_MS = Number(process.env.TRIGGER_CAPITALE_CADENZA_MS || 120_000);

/**
 * QUANTO SI ASPETTA DOPO UN MINI-CICLO prima di poterne fare un altro. Se il piazzamento riesce il
 * saldo scende sotto soglia e il trigger si spegne da solo; questo tetto serve al caso in cui NON
 * riesca — senza, si riproverebbe ogni due minuti su un guasto che non cambia da solo.
 */
const COOLDOWN_MS = Number(process.env.TRIGGER_CAPITALE_COOLDOWN_MS || 600_000);

/**
 * QUANTO SI ASPETTA DOPO UN CICLO COMPLETO. Subito dopo un reset il saldo è in movimento (gli ordini
 * appena mandati stanno immobilizzando collaterale) e leggerlo darebbe un «capitale fermo» che fra
 * trenta secondi non esiste più. Tre minuti sono il tempo perché il libro si assesti.
 */
const QUIETE_DOPO_CICLO_MS = Number(process.env.TRIGGER_CAPITALE_QUIETE_MS || 180_000);

/**
 * IL MINIMO CHE VALE LA PENA PIAZZARE. Sotto i $34 — il nozionale mediano dei 21 maker di riferimento —
 * non si sta rimettendo al lavoro un ordine, si sta spolverando. Il gate DURO resta comunque quello del
 * venue (`min_incentive_size`), che vive più a valle e che questo modulo non riscrive.
 */
const MIN_ALLOCAZIONE_USD = Number(process.env.TRIGGER_CAPITALE_MIN_USD || 34);

/**
 * QUANTO PUÒ ESSERE VECCHIA LA FOTOGRAFIA DEL BOARD su cui si quota. agent24 la riscrive ogni 15
 * minuti: 20 minuti sono quel ciclo più un margine. Oltre, il tocco vivo non è più vivo e il
 * mini-ciclo non piazza — la freschezza che si dichiara è quella del dato che si USA per il prezzo.
 */
const ETA_BOARD_MAX_MS = Number(process.env.TRIGGER_CAPITALE_BOARD_MAX_MS || 20 * 60_000);

/**
 * SCATTA O NO. Pura: l'orologio, il saldo e lo stato arrivano da fuori, così ogni ramo si prova senza
 * aspettare due minuti e senza toccare un venue.
 *
 * L'ordine dei controlli non è casuale — si va dal più economico al più costoso, e dal più categorico
 * al più contingente: prima ciò che vieta (spento, bot fermo, un ciclo in corso), poi ciò che aspetta
 * (quiete, cooldown), poi il dato vero (saldo).
 *
 * @returns {{scatta:boolean, motivo:string, eccedenzaUsd:number|null, saldoUsd:number|null}}
 */
function decidiTrigger({
  abilitato = true, botAttivo = false, cicloInCorso = false,
  saldo = null, sogliaUsd = SOGLIA_USD,
  ultimoCicloAt = null, ultimoTriggerAt = null, now = Date.now(),
  quieteMs = QUIETE_DOPO_CICLO_MS, cooldownMs = COOLDOWN_MS,
} = {}) {
  const no = (motivo) => ({ scatta: false, motivo, eccedenzaUsd: null, saldoUsd: saldo && saldo.readable ? saldo.usd : null });

  if (!abilitato) return no('trigger spento');
  // Lo STESSO cancello del ciclo fisso, riletto adesso: FERMA vale dal controllo successivo, non dal
  // prossimo riavvio. Un trigger che piazzasse a bot fermo sarebbe un secondo interruttore.
  if (!botAttivo) return no('il bot è FERMO: nessun piazzamento, nemmeno da trigger');
  // IL LUCCHETTO. Il ciclo a sei ore e il mini-ciclo lavorano sullo stesso capitale e sugli stessi
  // ordini: sovrapporli significherebbe che il secondo legge un saldo che il primo sta già spendendo.
  if (cicloInCorso) return no('un ciclo è già in corso: il mini-ciclo non si sovrappone');
  if (fin(ultimoCicloAt) && now - ultimoCicloAt < quieteMs) {
    return no(`quiete dopo un ciclo completo: mancano ${Math.ceil((quieteMs - (now - ultimoCicloAt)) / 1000)}s (il saldo si sta ancora assestando)`);
  }
  if (fin(ultimoTriggerAt) && now - ultimoTriggerAt < cooldownMs) {
    return no(`cooldown dal mini-ciclo precedente: mancano ${Math.ceil((cooldownMs - (now - ultimoTriggerAt)) / 1000)}s`);
  }
  // Un saldo NON LEGGIBILE non è un saldo zero e non è un saldo basso: è un'incognita, e su
  // un'incognita non si piazza. Stessa regola che il resto del maker applica al kill state.
  if (!saldo || saldo.readable !== true || !fin(saldo.usd)) {
    return no(`saldo non leggibile (${(saldo && saldo.error) || 'nessuna lettura'}): non si piazza su un'incognita`);
  }
  if (saldo.usd < sogliaUsd) {
    return no(`capitale liquido $${saldo.usd.toFixed(2)} sotto la soglia di $${sogliaUsd.toFixed(2)}`);
  }
  return {
    scatta: true,
    motivo: `capitale liquido fermo $${saldo.usd.toFixed(2)} ≥ soglia $${sogliaUsd.toFixed(2)}`,
    eccedenzaUsd: +saldo.usd.toFixed(2),
    saldoUsd: +saldo.usd.toFixed(2),
  };
}

/**
 * LE SHARE PER LATO A UN CAPITALE DIVERSO. Non è una formula nuova: sono le DUE identità che
 * lib/rewards/allocator.js usa per costruire la riga, riscritte qui sopra lo stesso ordine di
 * preferenza — col costo della coppia quando la riga ce l'ha, altrimenti `(capitale/2)/prezzo`.
 * Se divergessero, il mini-ciclo manderebbe una size diversa da quella con cui il piano ha scorato.
 */
function shareARiscalo(riga, nuovoCapitale) {
  if (!fin(nuovoCapitale) || nuovoCapitale <= 0) return null;
  if (fin(riga.pairCostUsd) && riga.pairCostUsd > 0) return nuovoCapitale / riga.pairCostUsd;
  const prezzo = fin(riga.mid) && riga.mid > 0 ? Math.max(0.01, Math.min(0.99, riga.mid)) : null;
  if (prezzo == null) return null;
  return (nuovoCapitale / 2) / prezzo;
}

/**
 * QUALE MERCATO, E QUANTO. Pura.
 *
 * Si scorre l'ultimo piano dal mercato che rende di più, e per ognuno si guarda quanto SPAZIO ha:
 * il capitale che il piano gli aveva assegnato, meno quello che ha già a riposo adesso. Un mercato
 * pieno non ha spazio; uno svuotato da una chiusura ce l'ha tutto. È così che il capitale liberato
 * torna dove il piano lo voleva, senza inventare un piano nuovo.
 *
 * @param righe            le righe dell'ULTIMO piano (già ridotte all'essenziale)
 * @param disponibileUsd   il capitale liquido da rimettere al lavoro
 * @param notionalePerMercato  {marketId → $ a riposo adesso}
 * @param capPerMercatoUsd il tetto di concentrazione per mercato, dal chiamante (mai riscritto qui)
 * @returns {{riga:object, allocatoUsd:number}|{riga:null, motivo:string, esaminate:object[]}}
 */
/**
 * `gambeCostruibili` — IL CANCELLO CHE MANCAVA, E PERCHÉ STA QUI DENTRO (8 agosto 2026).
 *
 * Fino a oggi questa funzione sceglieva UN mercato e lo consegnava; se poi le sue due gambe non si
 * riuscivano a costruire, il mini-ciclo si fermava lì e il capitale restava fermo — pur avendo nel
 * piano altre righe perfettamente utilizzabili. Non è ipotetico: la riga in testa al piano dell'8
 * agosto ha `tick: null`, quindi le gambe non esistono, e il trigger non ha mai passato quella riga.
 *
 * Il predicato è INIETTATO e non importato: questo modulo resta puro e senza dipendenze, e la
 * costruzione delle gambe continua a vivere in UN posto solo (`lib/rewards/plan-to-orders.js`). Chi
 * non lo passa ottiene esattamente il comportamento di prima.
 *
 * Firma: `(riga) => ({ ok: boolean, motivo?: string })`. La riga che riceve è già quella definitiva —
 * capitale e share riscalati — perché è quella che finirebbe al venue, non la sua approssimazione.
 */
function scegliMercato({
  righe = [], disponibileUsd = 0, notionalePerMercato = {}, capPerMercatoUsd = null,
  minAllocazioneUsd = MIN_ALLOCAZIONE_USD, gambeCostruibili = null,
} = {}) {
  const esaminate = [];
  const valore = (r) => (fin(r.realisticBestPerDay) ? r.realisticBestPerDay
    : (fin(r.netPerDay) ? r.netPerDay : (fin(r.grossPerDay) ? r.grossPerDay : -Infinity)));
  const ordinate = (righe || []).slice().sort((a, b) => valore(b) - valore(a));

  for (const r of ordinate) {
    const id = normId(r.marketId);
    if (!id) continue;
    const pianificato = fin(r.capital) ? r.capital : 0;
    const tetto = fin(capPerMercatoUsd) && capPerMercatoUsd > 0 ? Math.min(pianificato, capPerMercatoUsd) : pianificato;
    const vivo = fin(notionalePerMercato[id]) ? notionalePerMercato[id] : 0;
    const spazio = +(tetto - vivo).toFixed(2);
    const allocabile = +Math.min(disponibileUsd, Math.max(0, spazio)).toFixed(2);

    if (allocabile < minAllocazioneUsd) {
      esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio, motivo: spazio <= 0 ? 'nessuno spazio: il mercato è già al capitale del piano' : `spazio $${spazio.toFixed(2)} sotto il minimo di $${minAllocazioneUsd}` });
      continue;
    }
    const share = shareARiscalo(r, allocabile);
    if (share == null) {
      esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio, motivo: 'share per lato non ricalcolabili (né costo della coppia né mid)' });
      continue;
    }
    if (fin(r.minSizeShares) && r.minSizeShares > 0 && share < r.minSizeShares) {
      esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio, motivo: `${share.toFixed(1)} share sotto il minimo del venue (${r.minSizeShares})` });
      continue;
    }
    // La riga che si consegna al costruttore delle gambe è la STESSA del piano, con due soli campi
    // riscritti: il capitale e le share che ne derivano. Tutto il resto — tick, banda, offset scelto,
    // tocco vivo — resta quello che il piano aveva calcolato, perché è quello che lo ha reso ammissibile.
    const riga = { ...r, capital: allocabile, sizePerSideShares: share };

    // L'ULTIMO CANCELLO, e l'unico che sa se un ordine è davvero costruibile. Una riga che non passa
    // NON ferma la ricerca: si annota il motivo e si prova la successiva, esattamente come per lo
    // spazio insufficiente o le share sotto il minimo. Il capitale fermo non deve restare fermo per
    // colpa della prima riga della graduatoria.
    if (typeof gambeCostruibili === 'function') {
      let v;
      // Un predicato che ESPLODE non deve poter fermare il ciclo: vale come «non costruibile», con il
      // motivo. È lo stesso principio del resto del maker — un'incognita non è mai un via libera.
      try { v = gambeCostruibili(riga); }
      catch (e) { v = { ok: false, motivo: `il controllo delle gambe è fallito: ${e && e.message}` }; }
      if (!v || v.ok !== true) {
        esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio,
          motivo: `gambe non costruibili: ${(v && v.motivo) || 'motivo non dichiarato'}` });
        continue;
      }
    }

    return { riga, allocatoUsd: allocabile, esaminate };
  }
  return {
    riga: null,
    allocatoUsd: 0,
    motivo: esaminate.length
      ? 'nessun mercato del piano ha spazio sufficiente adesso'
      : 'l\'ultimo piano non ha righe utilizzabili',
    esaminate,
  };
}

/** Il nozionale a riposo per mercato, dagli ordini letti dal venue. Somma prezzo × size residua. */
function notionalePerMercato(ordini) {
  const out = {};
  for (const o of (ordini || [])) {
    const id = normId(o && o.marketId);
    if (!id) continue;
    const p = Number(o.price);
    const s = Number(o.sizeRemaining != null ? o.sizeRemaining : o.size);
    // `Number(null)` vale 0, e 0 e' finito: senza il controllo sul segno un ordine col prezzo
    // illeggibile sarebbe entrato come nozionale ZERO — cioe' come «questo mercato e' vuoto», che e'
    // esattamente la conclusione sbagliata, perche' porterebbe a metterci sopra altro capitale.
    if (!fin(p) || p <= 0 || !fin(s) || s <= 0) continue;
    out[id] = +((out[id] || 0) + p * s).toFixed(6);
  }
  return out;
}

module.exports = {
  decidiTrigger, scegliMercato, shareARiscalo, notionalePerMercato,
  SOGLIA_USD, CADENZA_MS, COOLDOWN_MS, QUIETE_DOPO_CICLO_MS, MIN_ALLOCAZIONE_USD, ETA_BOARD_MAX_MS,
};

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

// ═══ LE DUE FONTI DEL TOTALE NON SONO CO-TEMPORALI — §5.2 p.54, chiuso il 22 agosto 2026 ═══════════
//
// ⚠ IL FATTO, RICOSTRUITO AL CENTESIMO. Il 20 agosto alle 22:36:02Z il guardiano ha letto un totale di
// $1.438,41 e ha SCATTATO: libro cancellato, bot su FERMA, 6h06m di fermo. L'equity vera in quella
// finestra non si e' mai mossa da $1.491-1.495. Quel numero e' la somma di due fotografie di istanti
// diversi:
//        saldo delle 22:30:07 ($1.402,98)  +  posizioni delle 22:26:06 ($35,42)  =  $1.438,40
// cioe' **241 secondi di scarto**. Il saldo aveva gia' registrato il DEBITO di tre fill; lo snapshot
// non ne aveva ancora l'ATTIVO. Il guardiano ha contato la cassa uscita senza la merce entrata.
// Altre due letture della stessa serata si ricostruiscono allo stesso modo, una nel verso opposto:
//        22:30:58 = saldo(22:30) + posizioni(22:31)  = $1.472,00   (scarto 61 s, verso BASSO)
//        22:34:31 = saldo(22:35) + posizioni(22:34)  = $1.513,25   (scarto 60 s, verso ALTO)
// Il verso ALTO e' lo stesso difetto di D-D (§5-bis p.202): il 16/08 alle 19:28 il riferimento fu
// fissato a $1.550,18 = saldo POST-chiusura + posizioni PRE-chiusura, cioe' $57,10 contati due volte.
// **Un difetto solo, due versi.**
//
// ⚠ PERCHE' NON UNA TOLLERANZA SUI TIMESTAMP, che e' la cura che viene in mente per prima. MISURATA e
// SCARTATA: lo scarto temporale NON separa le letture contaminate dalle pulite. Su 9.324 campioni con
// l'eta' dichiarata dello snapshot, le 11 letture contaminate hanno eta' fra **749 ms e 52 s**, cioe'
// sovrapposte alle pulite; a tolleranza 5 s si rifiuterebbe l'87% delle letture e ne passerebbero
// comunque 2 su 11. La ragione e' strutturale: `writeVenuePositions` timbra `at = now()` all'istante
// della SCRITTURA, non della lettura del venue — infatti la lettura delle 22:36 aveva 241 s di scarto
// vero con uno snapshot che si dichiarava fresco. **Un timestamp che non misura la staleness del
// contenuto non puo' essere il criterio.**
//
// ⚠ E NEMMENO LA CO-TEMPORALITA' VERA E' RAGGIUNGIBILE DA QUI: ne' il saldo ne' le posizioni si possono
// ricampionare a un istante passato, quindi «leggerle allo stesso istante» non e' una cosa che questo
// modulo possa fare. Quello che si puo' fare e' ACCORGERSI che non lo erano, ed e' quello che segue.
//
// ═══ IL CRITERIO: LA CONSERVAZIONE DEL VALORE ══════════════════════════════════════════════════════
// Un fill non crea e non distrugge valore: converte cassa in posizione, o posizione in cassa, uno a uno.
// Quindi fra due letture contigue deve valere
//        Δcassa  +  Δvalore_dovuto_alle_SIZE  ≈  0
// e se non vale, le due fonti stanno descrivendo due istanti diversi: **il totale non e' misurabile**.
//
// ⚠⚠ «DOVUTO ALLE SIZE» E' LA META' CHE CONTA, E NON E' UN'OTTIMIZZAZIONE. Il valore delle posizioni si
// muove per DUE ragioni: perche' cambia la size (un fill, una chiusura, un merge — e allora la cassa
// deve muoversi in modo opposto) e perche' cambia il PREZZO (ed e' P&L vero, con la cassa ferma). Un
// criterio scritto sul valore totale rifiuterebbe anche i movimenti di solo prezzo — cioe' accecherebbe
// il guardiano ESATTAMENTE durante un crollo vero, che e' l'unica cosa che deve vedere. Misurato su
// 4.646 campioni a cassa ferma e insieme di posizioni identico, il solo prezzo arriva a **$12,93**,
// sopra qualunque tolleranza sensata. Percio' si attribuisce il Δvalore alle size, prezzo per prezzo, e
// si riconcilia SOLO quella parte.
//
// ═══ LA TOLLERANZA VIENE DALLA TABELLA, E IL DIVARIO E' VUOTO ══════════════════════════════════════
// Su tutte le 29 letture contigue con movimento di cassa nei giornali dell'osservatore (6,6 giorni):
//        compensate (fill visto da entrambe le fonti):  18 · residuo MASSIMO  $4,95
//        NON compensate (una fonte indietro):           11 · residuo MINIMO   $8,32
// Fra $4,95 e $8,32 non c'e' niente. `$6,00` sta nel vuoto — la stessa disciplina con cui si e' scelto
// l'85% della sentinella (§5-bis p.142): la soglia si mette nel divario, non a occhio.
const TOLLERANZA_RICONCILIAZIONE_USD = 6;

/**
 * LE DUE FONTI RACCONTANO LO STESSO ISTANTE? Pura, nessun `require`, nessun orologio proprio.
 *
 * ⚠ FAIL-CLOSED IN TUTTI I RAMI IN CUI NON SI PUO' GIUDICARE: prima lettura, letture non contigue,
 * componenti mancanti, un prezzo che non si legge ⇒ `confrontabile:false` ⇒ **non misurabile**. Costa
 * un giro di cecita' (30 s) dopo un riavvio o un buco; il falso scatto che chiude e' costato 6h06m.
 * E' la stessa semantica di §5-bis p.141: «non ho letto» non puo' confermare niente.
 *
 * @param a.precedente {at, saldoUsd, posizioni} della lettura precedente, o null
 * @returns {{confrontabile:boolean, coerente:boolean, motivo:string|null,
 *            deltaCassaUsd:number|null, deltaSizeUsd:number|null, residuoUsd:number|null}}
 */
function riconciliaFonti({ precedente = null, saldoUsd = null, posizioni = null, at = null,
  tolleranzaUsd = TOLLERANZA_RICONCILIAZIONE_USD,
  etaMassimaMs = ETA_MASSIMA_FRA_LETTURE_MS } = {}) {
  const no = (motivo) => ({ confrontabile: false, coerente: false, motivo,
    deltaCassaUsd: null, deltaSizeUsd: null, residuoUsd: null });

  const sOra = num(saldoUsd);
  if (!Number.isFinite(sOra)) return no('saldo non leggibile: non c\'e' + ' niente da riconciliare');
  if (!Array.isArray(posizioni)) return no('posizioni non leggibili: non si puo\' attribuire il Δvalore alle size');
  if (!precedente || typeof precedente !== 'object') {
    return no('prima lettura: non c\'e' + ' una precedente con cui riconciliare le due fonti');
  }
  const sPrec = num(precedente.saldoUsd);
  if (!Number.isFinite(sPrec)) return no('la lettura precedente non aveva un saldo leggibile');
  if (!Array.isArray(precedente.posizioni)) return no('la lettura precedente non aveva posizioni leggibili');

  // ⚠ CONTIGUITA': fra due letture lontane puo' essere successo di tutto, e un residuo grande non
  // direbbe piu' «una fonte e' indietro» ma «e' passato molto tempo». Stessa costante dello scatto.
  const tOra = num(at); const tPrec = num(precedente.at);
  if (!Number.isFinite(tOra) || !Number.isFinite(tPrec)) return no('istanti delle due letture non leggibili');
  const eta = tOra - tPrec;
  if (!(eta >= 0 && eta <= etaMassimaMs)) {
    return no(`la lettura precedente non e' contigua (${Math.round(eta / 1000)}s, limite ${Math.round(etaMassimaMs / 1000)}s)`);
  }

  const mappa = (arr) => {
    const m = new Map();
    for (const p of arr) {
      const id = String((p && p.tokenId) || '');
      if (!id) continue;
      m.set(id, { size: num(p && p.size), prezzo: num(p && p.curPrice) });
    }
    return m;
  };
  const ora = mappa(posizioni); const pre = mappa(precedente.posizioni);

  // Δvalore ATTRIBUITO ALLE SIZE: per ogni token, (size_ora − size_prec) valutata al prezzo che
  // abbiamo. Un token sparito si valuta al SUO ultimo prezzo noto — quello di adesso non esiste.
  let deltaSize = 0;
  for (const id of new Set([...ora.keys(), ...pre.keys()])) {
    const a = ora.get(id) || { size: 0, prezzo: NaN };
    const b = pre.get(id) || { size: 0, prezzo: NaN };
    const sA = Number.isFinite(a.size) ? a.size : (ora.has(id) ? NaN : 0);
    const sB = Number.isFinite(b.size) ? b.size : (pre.has(id) ? NaN : 0);
    if (!Number.isFinite(sA) || !Number.isFinite(sB)) return no(`posizione ${id.slice(0, 12)}… senza size: il Δvalore non e' attribuibile`);
    if (sA === sB) continue;                       // size ferma ⇒ qualunque Δvalore e' prezzo, non fill
    const prezzo = Number.isFinite(a.prezzo) ? a.prezzo : b.prezzo;
    // ⚠ Un prezzo che non si legge NON diventa zero: sarebbe un fill da $0, cioe' un residuo nullo,
    // cioe' un'incoerenza dichiarata coerente. E' la famiglia `Number(null) === 0` di §5.3.
    if (!Number.isFinite(prezzo)) return no(`posizione ${id.slice(0, 12)}… con size cambiata e prezzo non leggibile: il Δvalore non e' attribuibile`);
    deltaSize += (sA - sB) * prezzo;
  }

  const deltaCassa = sOra - sPrec;
  const residuo = deltaCassa + deltaSize;
  const coerente = Math.abs(residuo) <= tolleranzaUsd;
  return {
    confrontabile: true,
    coerente,
    motivo: coerente ? null
      : `le due fonti non descrivono lo stesso istante: la cassa si e' mossa di $${deltaCassa.toFixed(2)}`
        + ` e le posizioni di $${deltaSize.toFixed(2)} in size — residuo $${residuo.toFixed(2)},`
        + ` oltre la tolleranza di $${tolleranzaUsd.toFixed(2)}. Un fill non crea ne' distrugge valore:`
        + ' una delle due letture e\' indietro, e il totale sarebbe un numero che l\'equity non ha mai avuto',
    deltaCassaUsd: +deltaCassa.toFixed(6),
    deltaSizeUsd: +deltaSize.toFixed(6),
    residuoUsd: +residuo.toFixed(6),
  };
}

/** Il totale in dollari, o `null` se anche un solo pezzo non è leggibile. Mai uno zero di ripiego.
 *
 * ⚠ `riconciliazione` NON HA UN DIFETTO PERMISSIVO, ed è voluto: ometterla vale «non misurabile», non
 * «misura come prima». Una dep non cablata che restituisce il comportamento vecchio è la classe di
 * difetto con quattro occorrenze in questo repo (§5.3) — e qui varrebbe a riaprire §5.2 p.54 in
 * silenzio. Chi non vuole il controllo lo dichiara con `'non-richiesta'`, che si trova con un grep.
 */
function valutaCapitale({ saldoUsd = null, posizioni = null, posizioniLeggibili = true,
  riconciliazione } = {}) {
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

  // ── LE DUE FONTI DESCRIVONO LO STESSO ISTANTE? (§5.2 p.54) ─────────────────────────────────────
  // Si valuta SOLO se le due componenti si leggono: senza di esse non c'e' niente da riconciliare, e
  // il rifiuto arriva comunque dalle righe qui sopra con il suo motivo, che e' piu' preciso.
  let rico = null;
  if (saldo !== null && valorePosizioni !== null) {
    if (riconciliazione === 'non-richiesta') {
      // Chi OSSERVA e non decide (agent45) registra il totale grezzo: e' lo strumento con cui
      // l'artefatto e' stato misurato, e uno strumento che si autocensura non misura piu' niente.
      rico = { confrontabile: false, coerente: true, motivo: null, richiesta: false,
        deltaCassaUsd: null, deltaSizeUsd: null, residuoUsd: null };
    } else {
      const r = riconciliaFonti({
        precedente: (riconciliazione && riconciliazione.precedente) || null,
        saldoUsd: saldo,
        posizioni: Array.isArray(posizioni) ? posizioni : [],
        at: riconciliazione ? riconciliazione.at : null,
      });
      rico = { ...r, richiesta: true };
      if (!(r.confrontabile === true && r.coerente === true)) motivi.push(r.motivo);
    }
  }

  const leggibile = saldo !== null && valorePosizioni !== null
    && !!(rico && rico.coerente === true);
  return {
    leggibile,
    totaleUsd: leggibile ? +(saldo + valorePosizioni).toFixed(6) : null,
    saldoUsd: saldo,
    valorePosizioniUsd: valorePosizioni === null ? null : +valorePosizioni.toFixed(6),
    posizioni: dettaglio,
    // ⚠ IL VERDETTO VIAGGIA CON LA LETTURA: senza, «non misurabile per riconciliazione» e «non
    // misurabile perche' il venue non risponde» sarebbero lo stesso silenzio, e sono due diagnosi
    // diverse — una e' un fill in volo, l'altra e' un guasto.
    riconciliazione: rico,
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

// ══ LA PERSISTENZA: DUE LETTURE CONSECUTIVE, NON UNA ═══════════════════════════════════════════════
//
// ⚠ PERCHÉ 2 E NON 1, con i numeri che l'hanno deciso. Il 13 agosto 2026 alle 09:08:33Z il guardiano
// è scattato su −$36,15 / −5,47% e ha cancellato 23 ordini su 12 mercati. **Era un falso positivo**:
// la lettura on-chain 37 minuti dopo dava $518,39 di saldo + $135,40 di posizioni = **$653,79** contro
// una baseline di $660,56, cioè **−$6,77 (−1,02%)**. Circa **$29 dei $36 erano transitori**.
//
// La causa non è la soglia: è che **il segnale è più rumoroso della soglia**. Distribuzione dei salti
// di PnL fra letture a 30 s, misurata su 5 giorni e 7.211 campioni del log di questo stesso agente:
//
//     mediana $0,00 · q95 $0,12 · q99 $1,18 · **max $74,47**
//     32 salti oltre $10 · 12 oltre $20 · **7 oltre $30** — contro una soglia assoluta di $30
//
// I più grandi arrivano **in coppie che si annullano**: +$74,47 alle 09/08 11:59:11 e −$73,12 trenta
// secondi dopo. E la sequenza esatta dello scatto lo mostra meglio di qualunque argomento:
//
//     09:05:03  −$26,46   ← salto di −$24,80 in 30 s
//     09:05:33   −$1,37   ← rientrato per INTERO. Non scatta solo perché è sotto i $30
//     09:07:33   +$8,06
//     09:08:03   −$4,70
//     09:08:33  −$36,15   ← SCATTO, su un transitorio della stessa famiglia
//
// Con due letture consecutive richieste, **nessuna delle due punte sarebbe diventata uno scatto**,
// perché entrambe rientrano al campione successivo. Questo è il senso di `k = 2`: non alza la soglia
// — che resta $30 e 5% — chiede solo che la perdita **sia ancora lì trenta secondi dopo**.
//
// ⚠ PERCHÉ NON 3 O PIÙ. Ogni conferma in più costa 30 secondi di ritardo su uno scatto VERO, cioè su
// una perdita che sta davvero correndo. Due letture costano al più 30 s e tolgono l'intera famiglia di
// transitori misurata (tutti rientrati in un solo campione). Tre non toglierebbero niente di più e
// raddoppierebbero il ritardo: non c'è nessun transitorio osservato che duri due campioni.
const LETTURE_CONSECUTIVE_PER_SCATTO = 2;

// ⚠ CONSECUTIVE VUOL DIRE ANCHE CONTIGUE NEL TEMPO. Il giro è di 30 s; oltre 120 s (quattro giri) fra
// una lettura e l'altra non si sta più guardando la stessa perdita, si stanno accostando due fotografie
// lontane. Una lettura persa — processo bloccato, venue che non risponde — NON deve valere come
// conferma: il contatore riparte da capo.
const ETA_MASSIMA_FRA_LETTURE_MS = 120_000;

/**
 * LA CONFERMA: questa lettura oltre soglia fa scattare, o è solo la prima?
 *
 * Modulo PURO e stato ESPLICITO: lo stato entra ed esce, non vive qui dentro. Chi chiama lo tiene fra
 * un giro e l'altro. Se il processo riparte, lo stato si perde e servono di nuovo due letture — ed è la
 * direzione giusta, perché un guardiano appena rinato non ha visto il campione precedente e non può
 * dire che la perdita «persisteva».
 *
 * ⚠ UNA LETTURA NON CALCOLABILE AZZERA IL CONTATORE, e non è un dettaglio. `decidiScatto` risponde
 * `scatta:false` sia quando la perdita è rientrata sia quando il PnL non si è potuto leggere, e sono
 * due fatti diversi: qui però portano alla stessa azione, perché «non ho letto» non può fare da ponte
 * fra due letture oltre soglia. Confermare attraverso un buco significherebbe far dire a un dato
 * mancante che la perdita persisteva — la stessa classe di errore di `Number(null) === 0`.
 *
 * @param a.stato      `{conferme, primaAt, ultimaAt, valoreUsd}` del giro precedente, o `null`
 * @param a.decisione  l'esito di `decidiScatto` per QUESTA lettura
 * @param a.pnl        il PnL di questa lettura, per poterlo dichiarare nel pre-allarme
 * @param a.now        istante di questa lettura
 * @returns {{scatta:boolean, preAllarme:boolean, conferme:number, stato:object, motivo:string,
 *            azzeratoPer:string|null}}
 */
function confermaScatto({ stato = null, decisione = null, pnl = null, now = Date.now(),
  osservazione = null,
  k = LETTURE_CONSECUTIVE_PER_SCATTO, etaMassimaMs = ETA_MASSIMA_FRA_LETTURE_MS } = {}) {
  const vuoto = { conferme: 0, primaAt: null, ultimaAt: null, valoreUsd: null, saldoLetturaAt: null };
  const prec = stato && typeof stato === 'object' && Number.isFinite(Number(stato.conferme))
    ? stato : vuoto;

  // ── LA LETTURA È RIENTRATA (o non si è potuta leggere) ⇒ SI AZZERA ──────────────────────────────
  if (!decisione || decisione.scatta !== true) {
    const c = Number(prec.conferme) || 0;
    return {
      scatta: false, preAllarme: false, conferme: 0, stato: vuoto,
      azzeratoPer: c > 0 ? 'rientro' : null,
      motivo: c > 0
        ? `contatore azzerato: dopo ${c} lettura/e oltre soglia questa è rientrata — la perdita non persisteva`
        : 'entro soglia',
    };
  }

  // ── LA LETTURA È OLTRE SOGLIA. È CONTIGUA ALLA PRECEDENTE? ──────────────────────────────────────
  const eta = Number.isFinite(Number(prec.ultimaAt)) ? now - Number(prec.ultimaAt) : null;
  const contigua = Number(prec.conferme) > 0 && eta !== null && eta >= 0 && eta <= etaMassimaMs;
  const valoreUsd = pnl && Number.isFinite(Number(pnl.pnlUsd)) ? Number(pnl.pnlUsd) : null;

  // ══ È UNA SECONDA OSSERVAZIONE, O UNA COPIA DELLA PRIMA? ═══════════════════════════════════════
  //
  // ⚠ IL FATTO. Il 13 agosto 2026 alle 11:24:15Z il guardiano è scattato **con k=2 già attivo**, e le
  // due letture «consecutive» erano lo STESSO numero: −32,58335 USD, totale $627,98, identici a cinque
  // decimali. Non era una coincidenza, era aritmetica: `SALDO_CACHE_TTL_MS = 45_000` contro
  // `GUARDIAN_POLL_MS = 30_000` ⇒ **due giri consecutivi cadono dentro la stessa finestra di cache**,
  // quindi la seconda lettura non è una seconda osservazione: è una copia. k=2 confermava contro se
  // stesso, e il terzo scatto è stato il terzo falso positivo su tre.
  //
  // ⚠ ALZARE k NON SERVIVA: con la cache com'è, k=3 avrebbe confermato tre volte lo stesso numero.
  // Il difetto non è nel numero di conferme, è nell'indipendenza fra le letture.
  //
  // ── PERCHÉ IL TIMESTAMP E NON UN TTL PIÙ CORTO ────────────────────────────────────────────────
  // La strada alternativa era abbassare `SALDO_CACHE_TTL_MS` sotto la cadenza del guardiano. È stata
  // SCARTATA perché quella cache è **condivisa**: la usano agent40 (che gira ogni ~5 s), agent41 via
  // il trigger a capitale fermo, e agent45. Abbassare il TTL moltiplicherebbe le `eth_call` del
  // consumatore più intenso per risolvere il problema di quello meno intenso — cioè farebbe pagare a
  // tutti il difetto di uno. Questa condizione invece vive **solo qui**, non cambia una riga per
  // nessun altro chiamante, e non aggiunge nemmeno una chiamata di rete.
  //
  // ── COME SI RICONOSCE UNA LETTURA DISTINTA, ESATTAMENTE ───────────────────────────────────────
  // La cache restituisce `etaMs`, cioè quanto è vecchia la voce. Quindi `now − etaMs` **È** l'istante
  // in cui quella voce è stata scritta: due letture che vengono dalla stessa voce producono lo stesso
  // numero, sempre, indipendentemente da quando le si è chieste. Non è una euristica, è un'identità.
  //
  // ⚠ FALLISCE CHIUSO, NELLA DIREZIONE «NON SCATTA». Se l'istante non è leggibile non si può
  // DIMOSTRARE che la lettura sia nuova, quindi non conta come conferma: il contatore resta dov'è e si
  // aspetta un dato fresco. Costa al più un giro di ritardo su uno scatto vero (misurato: nel caso
  // peggiore la conferma arriva a 60 s invece che a 30 s, perché il TTL è 45 s); l'alternativa è
  // riprodurre il falso positivo che questa riga esiste per impedire.
  const letturaAt = osservazione && Number.isFinite(Number(osservazione.saldoLetturaAt))
    ? Number(osservazione.saldoLetturaAt) : null;
  const letturaPrec = Number.isFinite(Number(prec.saldoLetturaAt)) ? Number(prec.saldoLetturaAt) : null;
  // Distinta = si conosce l'istante di QUESTA lettura ed è diverso da quello della precedente.
  const distinta = letturaAt !== null && (letturaPrec === null || letturaAt !== letturaPrec);

  let conferme;
  let motivoStallo = null;
  if (!contigua) {
    conferme = 1;                       // prima lettura della serie (o dopo un buco temporale)
  } else if (distinta) {
    conferme = Number(prec.conferme) + 1;
  } else {
    conferme = Number(prec.conferme);   // stessa osservazione: NON conferma, e non azzera
    motivoStallo = letturaAt === null
      ? 'istante della lettura del saldo non leggibile: non si può dimostrare che sia un dato nuovo'
      : 'stessa lettura del saldo della conferma precedente (cache non ancora rinfrescata)';
  }

  const nuovo = {
    conferme,
    primaAt: contigua && Number.isFinite(Number(prec.primaAt)) ? Number(prec.primaAt) : now,
    ultimaAt: now,
    valoreUsd,
    // Si memorizza l'istante SOLO quando ha davvero contato: altrimenti una lettura muta
    // «consumerebbe» il timestamp e la successiva sembrerebbe distinta senza esserlo.
    saldoLetturaAt: motivoStallo === null ? letturaAt : letturaPrec,
  };
  const scatta = conferme >= k;
  const ripartito = !contigua && Number(prec.conferme) > 0;
  return {
    scatta,
    // Il PRE-ALLARME è ogni lettura oltre soglia che non fa ancora scattare: va vista, perché è
    // esattamente l'evento che prima si trasformava in un latch e adesso no.
    preAllarme: !scatta,
    conferme,
    stato: nuovo,
    azzeratoPer: ripartito ? 'buco-temporale' : null,
    // `inAttesaDiDatoFresco` viaggia nel verdetto perché chi legge il log sappia distinguere «sto
    // ancora contando» da «sto aspettando che la cache si rinfreschi»: sono due stalli diversi.
    inAttesaDiDatoFresco: motivoStallo !== null,
    saldoLetturaAt: letturaAt,
    motivo: scatta
      ? `${conferme} letture DISTINTE consecutive oltre soglia (${((now - nuovo.primaAt) / 1000).toFixed(0)}s fra la prima e questa): la perdita persiste`
      : motivoStallo
        ? `PRE-ALLARME ${conferme}/${k} FERMO: ${motivoStallo} — non conta come conferma`
        : ripartito
          ? `PRE-ALLARME 1/${k}: oltre soglia, ma sono passati ${(eta / 1000).toFixed(0)}s dalla lettura precedente (oltre ${etaMassimaMs / 1000}s): il contatore riparte da capo`
          : `PRE-ALLARME ${conferme}/${k}: oltre soglia, si aspetta la conferma del giro successivo prima di scattare`,
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
    // ⚠ I QUATTRO INGRESSI POSSONO ESSERE ASSENTI, DAL 17 AGOSTO 2026, e restano `null` invece di
    // essere inventati. Il secondo ingresso del guardiano — la perdita giornaliera REALIZZATA — non
    // legge il venue di proposito (si misura sul registro dei fill, quindi funziona anche quando il
    // venue non risponde): non ha un drawdown, non ha un baseline e non ha un totale. Prima queste
    // righe facevano `pnl.pnlUsd` su `null` e il referto MORIVA — cioe' la spazzata avveniva e il
    // verbale no, che e' lo stato peggiore dei due. Preso dal test, non dalla rilettura.
    guardian: {
      pnlUsd: pnl ? pnl.pnlUsd : null,
      pnlPct: pnl ? pnl.pnlPct : null,
      baselineUsd: baseline ? baseline.baselineUsd : null,
      baselineAt: (baseline && baseline.atIso) || null,
      totaleAttualeUsd: capitale ? capitale.totaleUsd : null,
      saldoUsd: capitale ? capitale.saldoUsd : null,
      valorePosizioniUsd: capitale ? capitale.valorePosizioniUsd : null,
      soglieSuperate,
      sogliaPct: Number.isFinite(sogliaPct) ? -Math.abs(sogliaPct) : null,
      sogliaAbs: Number.isFinite(sogliaAbs) ? -Math.abs(sogliaAbs) : null,
      // Quale delle due, in una parola, per chi legge di fretta alle quattro del mattino.
      scattataPer: Array.isArray(soglieSuperate) && soglieSuperate.length === 2
        ? 'entrambe'
        : (Array.isArray(soglieSuperate) && soglieSuperate[0]
          ? (soglieSuperate[0].soglia || soglieSuperate[0]) : null),
      botFermato,
      posizioniAlloScatto: capitale ? capitale.posizioni : null,
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
  riconciliaFonti, TOLLERANZA_RICONCILIAZIONE_USD,
  confermaScatto, LETTURE_CONSECUTIVE_PER_SCATTO, ETA_MASSIMA_FRA_LETTURE_MS,
};

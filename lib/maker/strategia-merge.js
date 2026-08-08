'use strict';
// lib/maker/strategia-merge.js — DOPO UN FILL: COMPLETARE LA COPPIA, NON SVENDERE LA GAMBA.
//
// ═══ LA MECCANICA DEL VENUE ═══════════════════════════════════════════════════════════════════════
// 1 YES + 1 NO dello stesso mercato sono un INSIEME COMPLETO e valgono $1 per costruzione. Quindi se
// la coppia costa meno di $1 il profitto e' matematico: non dipende da chi vince, non serve un
// compratore, non serve indovinare niente. `mergePositions` sul ConditionalTokens riconsegna la coppia
// e restituisce $1 di collaterale SUBITO, senza aspettare la risoluzione.
//
// ═══ LO STATO DI QUESTO MODULO — LEGGERE PRIMA DI ACCENDERLO ══════════════════════════════════════
// Il merge on-chain NON e' eseguibile dallo stack attuale, e non per una mancanza da colmare in
// mezz'ora. Quattro fatti, tutti verificati il 7 agosto 2026, non dedotti:
//
//   1 · NON ESISTE UN PERCORSO DI SCRITTURA ON-CHAIN. In tutto il repo non c'e' una sola
//       `sendTransaction` o `populateTransaction`: ogni lettura e' `eth_call`/`eth_getBalance`. E' una
//       proprieta' di sicurezza voluta, ripetuta negli header di lib/poly-chain-read.ts,
//       lib/maker/inventory-read.js e lib/maker/cancel-all.js — non un pezzo mancante.
//   2 · I TOKEN NON SONO DOVE STA LA CHIAVE. Le posizioni vivono nel FUNDER
//       0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee, che e' un CONTRATTO (bytecode letto: 137 byte, un
//       clone). L'EOA firmatario, come dice funder.js, «signs; it holds nothing». Una `mergePositions`
//       firmata dall'EOA fallirebbe: quell'indirizzo non possiede le share da fondere.
//   3 · IL FUNDER HA ZERO MATIC. Anche sapendo come fargli eseguire una call, non c'e' gas.
//   4 · MAKER_SIGNATURE_TYPE=3 — deposit wallet ERC-1271 (Solady ERC1967). L'interfaccia con cui gli
//       si fa eseguire una chiamata arbitraria non e' nel nostro stack e non e' API pubblica di
//       Polymarket. E sui mercati NEG-RISK (Schwartzel: negRisk=true) il merge passerebbe comunque dal
//       NegRiskAdapter, con semantica sua.
//
// ═══ PERCHE' IL MODULO ESISTE LO STESSO — E PERCHE' ORA E' ACCESO ═════════════════════════════════
// La sostanza economica dei Livelli 1 e 2 sopravvive al blocco: una coppia comprata a <= 99¢ vale $1
// alla risoluzione comunque, con o senza merge. Cambia UNA cosa, ed e' quella che l'operazione era
// stata pensata per ottenere: il capitale non si libera subito, resta fermo fino alla risoluzione.
//
// Comprare il secondo lato senza poter fondere quindi non e' la strategia originale: e' una strategia
// diversa, che immobilizza capitale nuovo per un profitto differito ma matematico. La decisione stava
// all'operatore, non a questo file — e l'8 agosto 2026 l'operatore l'ha presa in chat, esplicitamente,
// conoscendo il differimento. Da allora `MERGE_STRATEGY_ENABLED` e' true.
//
// I quattro fatti qui sopra restano tutti veri: il merge on-chain NON e' diventato eseguibile. Se un
// giorno lo diventera', i Livelli 1 e 2 non cambiano — cambia solo che il capitale torna subito invece
// che alla scadenza.
//
// LA FUNZIONE E' PURA. Nessun ordine, nessuna rete, nessun file: decide e basta. Chi la chiama piazza.

/** La coppia deve costare al massimo questo sotto il dollaro perche' valga la pena completarla. */
const MERGE_MIN_MARGIN_CENTS = 1;
/** Quanto si aspetta da maker (Livello 2) prima di ripiegare sull'uscita classica (Livello 3). */
const MERGE_WAIT_TIMEOUT_MIN = 60;
/**
 * L'interruttore. ACCESO dall'8 agosto 2026 su decisione esplicita dell'operatore in chat.
 *
 * COSA SIGNIFICA ACCESO, ESATTAMENTE. I Livelli 1 e 2 comprano il secondo lato: `auto-close.js` piazza
 * l'ordine di completamento invece dell'uscita ordinaria, e ci riprova secondo la gerarchia. NON accende
 * il merge on-chain, che resta impossibile da questo stack (`CTF_RELAYER_ENABLED = false`, e le quattro
 * ragioni del blocco qui sopra sono tutte ancora vere).
 *
 * LA CONSEGUENZA ECONOMICA, DETTA PRIMA E NON DOPO: senza merge la coppia completata non libera
 * capitale subito — lo IMMOBILIZZA fino alla risoluzione del mercato, quando il venue paga $1 esatto per
 * coppia. Il profitto (100¢ − costo della coppia) e' matematico e non dipende da chi vince, ma arriva
 * ALLA SCADENZA, non adesso. E' un profilo diverso da quello che i due livelli avevano in mente, ed e'
 * quello che l'operatore ha approvato sapendolo.
 *
 * SPEGNERLO: rimettere `false` qui. Non esiste una env che lo governi, deliberatamente — due
 * interruttori per una decisione sola vogliono dire che spegnerne uno non la spegne.
 */
const MERGE_STRATEGY_ENABLED = true;
/** Perche' e' spento, in una frase che finisce nell'audit invece di restare in un commento. */
const MERGE_DISABLED_REASON = 'merge on-chain non eseguibile dallo stack attuale (nessun percorso di'
  + ' scrittura on-chain; i token stanno nel funder-contratto, non nell EOA che firma; funder senza MATIC;'
  + ' deposit wallet ERC-1271 e mercati neg-risk) — senza merge completare la coppia immobilizza capitale'
  + ' invece di liberarlo, e quella e una decisione dell operatore';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const c = (p) => +(p * 100).toFixed(4);          // prezzo (0..1) → centesimi
const p = (cents) => +(cents / 100).toFixed(6);  // centesimi → prezzo

/**
 * IL TETTO DEL SECONDO LATO. Sopra questo prezzo la coppia costerebbe piu' di quanto rende.
 *   tetto = 100¢ − prezzo_gia_pagato − margine
 * @returns {number|null} prezzo (0..1), o null se il carico non e' leggibile o non lascia spazio.
 */
function tettoSecondoLato(prezzoRiempito, margineCents = MERGE_MIN_MARGIN_CENTS) {
  if (!fin(prezzoRiempito) || prezzoRiempito <= 0 || prezzoRiempito >= 1) return null;
  const tettoC = 100 - c(prezzoRiempito) - margineCents;
  if (!(tettoC > 0)) return null;
  return p(tettoC);
}

/**
 * QUANTO SI PUO' COMPRARE AL VOLO SENZA SFONDARE IL TETTO.
 * Cammina la scala degli ask del secondo lato e si ferma al primo livello troppo caro. Se la size
 * disponibile entro il tetto e' minore di quella che serve, si compra quella e il resto passa al
 * Livello 2 — meta' coppia a prezzo giusto vale piu' di una coppia intera a prezzo sbagliato.
 *
 * @returns {{size:number, costoMedio:number|null, prezzoPeggiore:number|null, livelli:number}}
 */
function quantoAlVolo(asks, tetto, sizeVoluta) {
  let size = 0; let costo = 0; let peggiore = null; let livelli = 0;
  // `letta` DISTINGUE DUE ZERI CHE NON SONO LO STESSO ZERO. Fino all'8 agosto 2026 questa funzione
  // restituiva `size: 0` sia per «ho camminato la scala e nessun livello sta sotto il tetto» sia per
  // «la scala non mi e' stata passata», e decidiLivello scriveva in audit «l ask e' sopra il tetto» in
  // entrambi i casi — una conclusione che nel secondo caso nessuno aveva misurato. Con readDepth non
  // iniettato in auto-close, il secondo caso era il 100% della produzione. Vedi CLAUDE.md §5 punto 27.
  const letta = Array.isArray(asks);
  if (!letta || !fin(tetto) || !fin(sizeVoluta) || sizeVoluta <= 0) {
    return { size: 0, costoMedio: null, prezzoPeggiore: null, livelli: 0, letta };
  }
  // Gli ask si camminano dal piu' economico: un feed che li desse in ordine sparso farebbe comprare
  // il livello caro prima di quello conveniente.
  const scala = asks
    .map((l) => ({ price: Number(l && l.price), size: Number(l && l.size) }))
    .filter((l) => fin(l.price) && fin(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);
  for (const l of scala) {
    if (l.price > tetto + 1e-9) break;
    const presa = Math.min(l.size, sizeVoluta - size);
    if (presa <= 0) break;
    size += presa; costo += presa * l.price; peggiore = l.price; livelli += 1;
    if (size >= sizeVoluta - 1e-9) break;
  }
  return {
    size: +size.toFixed(6),
    costoMedio: size > 0 ? +(costo / size).toFixed(6) : null,
    prezzoPeggiore: peggiore,
    livelli,
    letta,
  };
}

/**
 * LE COPPIE GIA' IN CASA. Se possediamo YES e NO dello stesso mercato per qualunque motivo storico,
 * la quantita' sovrapponibile e' capitale fermo che il merge libererebbe subito.
 *
 * @param positions  [{tokenId, size, avgPrice}] dal venue
 * @param rulesPerMercato  (marketId) => rules, per riconoscere i due token
 * @returns Array<{marketId, size, costoCoppia, profittoUsd, yes, no}>
 */
function coppieFondibili(positions, rulesPerMercato) {
  const perMercato = new Map();
  for (const pos of positions || []) {
    const tok = String((pos && (pos.tokenId ?? pos.asset)) || '');
    // `Number(null)` e' 0: un carico assente non deve travestirsi da «comprato gratis», che renderebbe
    // ogni coppia senza prezzo la piu' profittevole di tutte. Vedi campo-vuoto-non-e-zero.test.js.
    const numero = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
    const size = Math.abs(numero(pos && pos.size));
    const avg = numero(pos && pos.avgPrice);
    if (!tok || !fin(size) || size <= 0) continue;
    const mid = pos && pos.conditionId ? String(pos.conditionId) : null;
    if (!mid) continue;
    const rules = typeof rulesPerMercato === 'function' ? rulesPerMercato(mid) : null;
    if (!rules || rules.readable !== true) continue;
    const lato = tok === String(rules.tokenId) ? 'yes' : (tok === String(rules.tokenIdNo) ? 'no' : null);
    if (!lato) continue;
    if (!perMercato.has(mid)) perMercato.set(mid, { marketId: mid, yes: null, no: null });
    perMercato.get(mid)[lato] = { size, avgPrice: fin(avg) ? avg : null };
  }
  const out = [];
  for (const m of perMercato.values()) {
    if (!m.yes || !m.no) continue;
    const size = Math.min(m.yes.size, m.no.size);
    if (!(size > 0)) continue;
    const costoCoppia = (fin(m.yes.avgPrice) && fin(m.no.avgPrice)) ? +(m.yes.avgPrice + m.no.avgPrice).toFixed(6) : null;
    out.push({
      marketId: m.marketId, size: +size.toFixed(6), costoCoppia,
      // Quanto libererebbe il merge al netto di cio' che e' costata: null se un carico non si legge —
      // un profitto stimato su un prezzo assente sarebbe un numero inventato.
      profittoUsd: costoCoppia != null ? +((1 - costoCoppia) * size).toFixed(4) : null,
      yes: m.yes, no: m.no,
    });
  }
  return out;
}

/**
 * IL LIVELLO DA APPLICARE A UNA POSIZIONE APPENA CREATA DA UN FILL.
 *
 * @param {object} a
 *   book             'yes'|'no' — il lato RIEMPITO
 *   sizePosseduta    quanto il venue dice che teniamo di quel lato (mai la size dell'ordine originale:
 *                    un fill parziale riempie meno, e la logica vale sulla quantita' vera)
 *   prezzoCarico     il costo medio del lato riempito
 *   sizeAltroLato    quanto gia' possediamo dell'altro lato (la coppia puo' essere gia' parziale)
 *   asksAltroLato    la scala ask del secondo lato, nel suo spazio prezzo
 *   attesaDaMs       da quanto il Livello 2 sta aspettando (null = non ha ancora aspettato)
 *   now
 * @returns {{livello:1|2|3, azione:string, motivo:string, tetto:number|null, size:number|null,
 *            prezzo:number|null, numeri:object}}
 */
function decidiLivello({
  book = null, sizePosseduta = null, prezzoCarico = null, sizeAltroLato = 0,
  asksAltroLato = null, attesaDaMs = null, now = Date.now(),
  margineCents = MERGE_MIN_MARGIN_CENTS, timeoutMin = MERGE_WAIT_TIMEOUT_MIN,
} = {}) {
  const altro = book === 'yes' ? 'no' : 'yes';
  const base = { livello: 3, azione: 'auto-close', tetto: null, size: null, prezzo: null,
    numeri: { book, altroLato: altro, sizePosseduta, prezzoCarico, sizeAltroLato } };

  if (!fin(sizePosseduta) || sizePosseduta <= 0) {
    return { ...base, azione: 'niente', motivo: 'nessuna posizione da gestire su questo lato' };
  }
  if (!fin(prezzoCarico)) {
    // Senza il carico il tetto non si calcola, e un tetto indovinato e' il modo di comprare il secondo
    // lato troppo caro: si ripiega sull'uscita classica, che il carico ce l'ha per conto suo.
    return { ...base, motivo: 'prezzo di carico non leggibile: il tetto della coppia non si calcola, si ripiega sull uscita classica' };
  }

  const tetto = tettoSecondoLato(prezzoCarico, margineCents);
  base.tetto = tetto;
  base.numeri.tettoCents = tetto != null ? c(tetto) : null;
  if (tetto == null) {
    return { ...base, motivo: `il lato riempito e' costato ${c(prezzoCarico).toFixed(1)}¢: con un margine di`
      + ` ${margineCents}¢ non resta spazio per comprare l altro lato — la coppia costerebbe piu' di $1` };
  }

  // Quanto manca per completare la coppia. Una coppia gia' completa non ha secondo lato da comprare.
  const manca = +(sizePosseduta - (fin(sizeAltroLato) ? sizeAltroLato : 0)).toFixed(6);
  base.numeri.mancaAllaCoppia = manca;
  if (manca <= 0) {
    return { livello: 1, azione: 'merge', motivo: `la coppia e' gia' completa per ${sizePosseduta} share:`
      + ' non c e niente da comprare, resta solo da fondere', tetto, size: sizePosseduta, prezzo: null, numeri: base.numeri };
  }

  // ── LIVELLO 1 · l'altro lato e' gia' abbastanza economico da prenderlo al volo ──────────────────
  const alVolo = quantoAlVolo(asksAltroLato, tetto, manca);
  base.numeri.sizeAlVolo = alVolo.size;
  base.numeri.costoMedioAlVolo = alVolo.costoMedio;
  // Viaggia nell'audit: «il Livello 1 e' stato scartato perche' caro» e «il Livello 1 non e' stato
  // nemmeno valutabile» sono due fatti diversi, e solo il secondo e' un difetto da correggere.
  base.numeri.askLetta = alVolo.letta === true;
  if (alVolo.size > 0) {
    const coppia = c(prezzoCarico) + c(alVolo.costoMedio);
    return {
      livello: 1, azione: 'compra-taker', tetto, size: alVolo.size, prezzo: alVolo.prezzoPeggiore,
      motivo: `l ask di ${altro.toUpperCase()} sta entro il tetto: ${alVolo.size} share a ${c(alVolo.costoMedio).toFixed(1)}¢ medi`
        + ` su ${alVolo.livelli} livello/i · la coppia costa ${coppia.toFixed(1)}¢`
        + `${alVolo.size < manca ? ` — ne mancano ${(manca - alVolo.size).toFixed(2)}, che passano al Livello 2` : ''}`,
      numeri: { ...base.numeri, coppiaCents: +coppia.toFixed(2), residuo: +(manca - alVolo.size).toFixed(6) },
    };
  }

  // ── LIVELLO 3 · il tempo da maker e' finito ────────────────────────────────────────────────────
  // Si controlla PRIMA di riproporre il Livello 2: altrimenti un'attesa scaduta si rinnoverebbe da
  // sola a ogni giro e il timeout non scatterebbe mai.
  const attesaMs = fin(attesaDaMs) ? now - attesaDaMs : null;
  base.numeri.attesaMin = attesaMs != null ? +(attesaMs / 60_000).toFixed(1) : null;
  if (attesaMs != null && attesaMs >= timeoutMin * 60_000) {
    return { ...base, livello: 3, azione: 'auto-close',
      motivo: `${Math.round(attesaMs / 60_000)} minuti da maker sull altro lato senza completare la coppia`
        + ` (limite ${timeoutMin}): si cancella l ordine di completamento e si ripiega sull uscita classica`,
      numeri: base.numeri };
  }

  // ── LIVELLO 2 · si aspetta da maker, sotto il tetto ────────────────────────────────────────────
  // Il Livello 2 e' la risposta giusta a ENTRAMBI i modi in cui il Livello 1 puo' non scattare — un
  // ordine maker sotto il tetto e' limitato per costruzione, quindi non serve conoscere l'ask per
  // metterlo — ma il MOTIVO che finisce a verbale deve dire quale dei due e' successo.
  const perche = alVolo.letta
    ? `l ask di ${altro.toUpperCase()} e' sopra il tetto di ${c(tetto).toFixed(1)}¢`
    : `la scala ask di ${altro.toUpperCase()} NON e' disponibile (profondita' non letta): il Livello 1 non e'`
      + ' valutabile, e un prezzo non letto non si presume ne\' buono ne\' cattivo';
  return {
    livello: 2, azione: 'maker-con-tetto', tetto, size: manca, prezzo: null,
    askLetta: alVolo.letta === true,
    motivo: `${perche}: ci si mette da MAKER`
      + ` su ${altro.toUpperCase()} per ${manca} share, mai sopra il tetto. Intanto quell ordine matura anche reward.`
      + ` Se entro ${timeoutMin} minuti la coppia non si chiude, Livello 3.`,
    numeri: base.numeri,
  };
}

module.exports = {
  decidiLivello, tettoSecondoLato, quantoAlVolo, coppieFondibili,
  MERGE_MIN_MARGIN_CENTS, MERGE_WAIT_TIMEOUT_MIN, MERGE_STRATEGY_ENABLED, MERGE_DISABLED_REASON,
};

'use strict';
/**
 * L'ABBANDONO DI UNA POSIZIONE SCOPERTA — decisione dell'operatore, 23 agosto 2026.
 *
 * ═══ IL FATTO MISURATO CHE LA RENDE NECESSARIA ═══════════════════════════════════════════════════
 * Alle 13:22Z del 23 agosto due posizioni scoperte non avevano NESSUNA via d'uscita, e non per un
 * difetto: per due gate che fanno il loro mestiere.
 *   · `0xd947c421` «Don't Say Good Luck» NO 56,1 @ 0,065 — scoperta da **324,8 min**, gradino 3.
 *     L'uscita a 0,062 rifiutata da `end-of-scale` (mid 97,30¢ oltre la soglia di 97,0¢); il
 *     completamento a 94,5¢ morto al `merge-livello-3`. Valore residuo al bid camminato: **$1,52**.
 *   · `0xc5cd9325` «MrBeast 37-39M» YES 56,5 @ 0,05 — SELL rifiutato `OUT_OF_BAND`, BUY di
 *     completamento cancellato da `cancelled-lato-singolo-zero`. Valore residuo: **$0,41**.
 * Nelle sette ore misurate quelle due posizioni hanno consumato **151 + 6 tentativi** di piazzamento
 * dalla corsia di chiusura, tutti rifiutati, per un premio recuperabile che vale meno di due dollari.
 * Il bot non stava sbagliando: stava riprovando una cosa che non si può fare.
 *
 * ═══ LA REGOLA, E PERCHE' NON SOSTITUISCE R6 MA LA APPLICA ══════════════════════════════════════
 * R6 dice che **non si spende per uscire più di quanto la posizione valga**. Fin qui quella regola
 * viveva solo dentro il pavimento della scala (R7, il 5% del carico): diceva *quanto* concedere, mai
 * *quando smettere*. Questo modulo è l'altra metà — la stessa disuguaglianza, letta come cancello:
 *
 *     ABBANDONO  ⟺  valoreResiduo < SOGLIA   E   costoUscita ≥ valoreResiduo
 *
 * · `valoreResiduo` = il **bid CAMMINATO** per l'INTERA size, cioè i dollari che il libro paga
 *   ADESSO. Mai `size × mid`: la misura del 16 agosto (283 campioni, zero uscite in guadagno) dice
 *   che il mid non è consumabile, ed è lo stesso motivo per cui `presa-di-profitto` cammina la scala.
 * · `costoUscita` = la perdita realizzata che si accetta per liberarsi, presa dalla via più
 *   economica fra le due che il bot conosce:
 *      – VENDITA:  `size × (carico − bidCamminato)`
 *      – COPPIA :  `size × (carico + askAltroCamminato − 1)`
 *
 * ⚠⚠ SUL CLOB DI POLYMARKET LE DUE VIE COSTANO ESATTAMENTE LO STESSO, ED E' STRUTTURALE, NON UN CASO.
 * I due token di un mercato binario condividono un solo libro: un BUY di NO a `p` È un SELL di YES a
 * `1 − p`, quindi `askAltroLato = 1 − bidMioLato` per costruzione. Sostituendo:
 *      costoCoppia = size × (carico + (1 − bid) − 1) = size × (carico − bid) = costoVendita
 * Misurato sulle cinque posizioni vive del 23/08: **identiche alla quarta cifra, 5 su 5**. Il `min`
 * resta scritto lo stesso, e non è ridondanza difensiva: è l'unico punto che si accorgerebbe se il
 * venue disaccoppiasse i due libri. Un test asserisce l'identità **e** che il `min` la rispetti.
 *
 * ═══ LA SOGLIA E' DERIVATA, NON SCELTA ══════════════════════════════════════════════════════════
 *     SOGLIA_ABBANDONO_USD = PERDITA_MAX_FRAZIONE × MARKET_CAP_FIXED_USD = 0,05 × $61,25 = $3,0625
 * Le due grandezze sono **importate** dai moduli dove già vivono (`urgenza-scoperto`, `concentration`):
 * ricopiare uno dei due numeri sarebbe il reperto D1 su un limite di rischio.
 *
 * IL CONTO, in una riga: `PERDITA_MAX_FRAZIONE` è quanto R7 autorizza la scala d'urgenza a BRUCIARE
 * per liberare una gamba, e `MARKET_CAP_FIXED_USD` è la gamba più grande che questa configurazione
 * possa aprire. Il prodotto è quindi **il massimo che il bot possa legittimamente spendere per uscire
 * da una posizione qualsiasi**. Una posizione che vale meno di quella cifra è, per costruzione, una
 * posizione su cui la scala è autorizzata a spendere più di quanto la posizione valga — cioè
 * esattamente lo stato che R6 vieta. La soglia non è un gusto: è il punto in cui R6 si contraddice.
 *
 * ⚠ L'OPERATORE HA SUGGERITO «ordine di grandezza $5», E SUL BOARD DI OGGI I DUE NUMERI DANNO LO
 * STESSO VERDETTO su tutte e cinque le posizioni ($3,06 e $5,00 abbandonano le stesse due e salvano
 * le stesse tre). Si tiene il **derivato**, che è anche il più stretto: abbandonare è smettere di
 * provare, quindi il verso prudente è abbandonare di MENO.
 *
 * ═══ COSA L'ABBANDONO NON FA — ed è la metà che conta ═══════════════════════════════════════════
 * ⚠ NON CANCELLA NIENTE AL VENUE e NON VENDE: nessuna superficie di piazzamento o cancellazione è
 *   raggiungibile da qui (questo modulo è PURO: due `require` di sole costanti, zero I/O).
 * ⚠ NON TOGLIE LA POSIZIONE DAI CONTI: la posizione resta al venue, quindi resta dentro
 *   `readVenuePositions`, dentro il totale del guardiano, dentro `capitale-al-lavoro` e dentro il
 *   P&L. Abbandonare è smettere di **agire**, non smettere di **contare**.
 * ⚠ NON SPEGNE L'ANOMALIA DELLE QUATTRO ORE: quella riga continua a essere scritta a ogni giro
 *   finché la scopertura dura, e `auto-close` la emette PRIMA di guardare l'abbandono.
 * ⚠ LA COPPIA BATTE SEMPRE L'ABBANDONO: `sizeAltroLato > 0` ⇒ mai abbandonata. Una coppia completa
 *   si fonde e rende $1/share, e nessuna soglia può valere più di quella. `sizeAltroLato` non letta
 *   ⇒ **non giudicabile**, che è il verso fail-closed.
 * ⚠ E' REVERSIBILE: il giudizio si rifà a ogni giro sul libro di ADESSO. Basta un'osservazione che
 *   dica «recuperabile» per rientrare — asimmetrico apposta: si entra in abbandono con **due**
 *   osservazioni contigue, si esce con **una**.
 *
 * ⚠ FAIL-CLOSED SU OGNI INGRESSO: carico, size, `sizeAltroLato` non finiti, o una delle due scale
 *   che non copre l'INTERA size ⇒ `giudicabile:false` ⇒ **non abbandonata**, si continua a provare.
 *   Un libro che non si legge non deve poter far smettere di provare.
 */

const { PERDITA_MAX_FRAZIONE } = require('./urgenza-scoperto');
const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');

/** La soglia, DERIVATA dai due numeri che già governano R6/R7. Nessuna costante nuova. */
const SOGLIA_ABBANDONO_USD = +(PERDITA_MAX_FRAZIONE * MARKET_CAP_FIXED_USD).toFixed(4);

/** Osservazioni consecutive e contigue prima di abbandonare. La prima ARMA soltanto (idioma del repo). */
const OSSERVAZIONI_PER_ABBANDONO = 2;
/**
 * Quanto può distare un'osservazione dalla precedente e contare ancora come CONTIGUA. Il ciclo di
 * `auto-close` gira ogni ~60 s; cinque minuti sono cinque cicli, cioè «il presidio stava girando».
 * Oltre, il contatore riparte da uno: due letture lontane non sono una conferma.
 */
const CONTIGUITA_MAX_MS = 300_000;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Cammina una scala di livelli per `size`, dal migliore al peggiore.
 * @returns {{medio:number, totale:number, intera:boolean}|null} `null` se la scala non è leggibile.
 */
function camminaScala(livelli, size) {
  if (!Array.isArray(livelli) || !fin(size) || size <= 0) return null;
  let resta = size, totale = 0, presi = 0;
  for (const l of livelli) {
    const p = Number(l && l.price), s = Number(l && l.size);
    if (!(p > 0) || !(s > 0)) continue;
    const q = Math.min(resta, s);
    totale += p * q; presi += q; resta -= q;
    if (resta <= 1e-9) break;
  }
  if (presi <= 0) return null;
  return { medio: totale / presi, totale, intera: resta <= 1e-9 };
}

/**
 * IL GIUDIZIO SU UNA SINGOLA POSIZIONE SCOPERTA, sul libro di questo istante.
 *
 * @param {{carico:number, size:number, bidsMioLato:Array, asksAltroLato:Array,
 *          sizeAltroLato:number, soglia?:number}} arg
 *        `bidsMioLato`   i bid del token che possiedo, GIA' ripuliti dai nostri ordini;
 *        `asksAltroLato` gli ask del token contrario, GIA' ripuliti dai nostri ordini;
 *        `sizeAltroLato` quante share dell'altro token possiedo (0 = gamba nuda).
 * @returns {{abbandonabile:boolean, giudicabile:boolean, valoreResiduo:number|null,
 *            costoVendita:number|null, costoCoppia:number|null, costoUscita:number|null,
 *            bidCamminato:number|null, askAltroCamminato:number|null, soglia:number,
 *            causa:string, motivo:string}}
 */
function valutaAbbandono({ carico, size, bidsMioLato, asksAltroLato, sizeAltroLato,
  soglia = SOGLIA_ABBANDONO_USD } = {}) {
  const no = (causa, motivo, extra = {}) => ({
    abbandonabile: false, giudicabile: causa !== 'non-giudicabile',
    valoreResiduo: null, costoVendita: null, costoCoppia: null, costoUscita: null,
    bidCamminato: null, askAltroCamminato: null, soglia, causa, motivo, ...extra });

  if (!fin(carico) || carico <= 0) return no('non-giudicabile', 'carico non leggibile: senza il carico il costo d\'uscita non è calcolabile');
  if (!fin(size) || size <= 0) return no('non-giudicabile', 'size non leggibile');
  // ⚠ SI GUARDA `=== true`-style sul NUMERO, mai la truthiness: `sizeAltroLato` assente vale
  // `undefined`, e `undefined > 0` è false — cioè «gamba nuda», che è il verso SBAGLIATO.
  if (!fin(sizeAltroLato)) return no('non-giudicabile', 'quante share dell\'altro lato possiedo non è stato letto: senza quel numero non si distingue una gamba nuda da una coppia completa');
  if (sizeAltroLato > 0) return no('coppia-completa', `possiedo già ${sizeAltroLato} share dell'altro lato: la coppia si fonde e rende $1/share — nessuna soglia vale più di così`);

  const b = camminaScala(bidsMioLato, size);
  if (!b || b.intera !== true) {
    return no('non-giudicabile', 'la scala dei bid sul lato posseduto non copre l\'intera size: il valore residuo non è misurabile, e un valore non misurato non può far smettere di provare');
  }
  const a = camminaScala(asksAltroLato, size);
  if (!a || a.intera !== true) {
    return no('non-giudicabile', 'la scala degli ask sull\'altro lato non copre l\'intera size: la via della coppia non è prezzabile, quindi il costo d\'uscita non è il minimo di due vie ma di una sola — non si giudica');
  }

  const valoreResiduo = +b.totale.toFixed(6);
  const costoVendita = +(size * (carico - b.medio)).toFixed(6);
  const costoCoppia = +(size * (carico + a.medio - 1)).toFixed(6);
  // Il `min` di due numeri che sul CLOB coincidono per costruzione (vedi l'intestazione): resta
  // scritto perché è l'unico punto che se ne accorgerebbe se smettessero di coincidere.
  const costoUscita = Math.min(costoVendita, costoCoppia);

  const sottoSoglia = valoreResiduo < soglia;
  const costaPiuDiQuantoVale = costoUscita >= valoreResiduo;
  const abbandonabile = sottoSoglia && costaPiuDiQuantoVale;

  const numeri = {
    valoreResiduo, costoVendita, costoCoppia, costoUscita,
    bidCamminato: +b.medio.toFixed(6), askAltroCamminato: +a.medio.toFixed(6), soglia,
  };
  if (abbandonabile) {
    return { abbandonabile: true, giudicabile: true, ...numeri, causa: 'costa-piu-di-quanto-vale',
      motivo: `il libro paga $${valoreResiduo.toFixed(2)} per l'intera size (bid camminato `
        + `${(b.medio * 100).toFixed(2)}¢), sotto la soglia di $${soglia.toFixed(2)}, e uscire ne costa `
        + `$${costoUscita.toFixed(2)}: si spenderebbe più di quanto la posizione valga (R6). Si smette `
        + `di provare — nessun ordine viene cancellato e niente viene venduto.` };
  }
  return { abbandonabile: false, giudicabile: true, ...numeri,
    causa: sottoSoglia ? 'uscita-conveniente' : 'sopra-soglia',
    motivo: sottoSoglia
      ? `vale $${valoreResiduo.toFixed(2)} (sotto la soglia di $${soglia.toFixed(2)}) ma uscire costa `
        + `solo $${costoUscita.toFixed(2)}, meno di quanto si incassa: si continua a provare`
      : `vale $${valoreResiduo.toFixed(2)}, sopra la soglia di $${soglia.toFixed(2)}: si continua a provare` };
}

/** La chiave di una posizione nel registro: mercato + token, perché un mercato ha due token. */
const chiaveAbbandono = (marketId, tokenId) => `${String(marketId).toLowerCase()}|${String(tokenId)}`;

/**
 * IL REGISTRO — puro: riceve lo stato precedente e i giudizi di QUESTO giro, restituisce lo stato
 * nuovo. Chi lo scrive su disco è l'agente, non questo modulo.
 *
 * ⚠ ASIMMETRICO APPOSTA: si ENTRA in abbandono con `OSSERVAZIONI_PER_ABBANDONO` letture consecutive
 * e contigue, si ESCE con una sola. Entrare significa smettere di agire su capitale reale; uscire
 * significa tornare a provare. Il costo dei due errori non è lo stesso.
 *
 * @param {{registro:object, giudizi:Array<{chiave, marketId, tokenId, book, size, carico, giudizio}>,
 *          ora:number}} arg
 * @returns {{registro:object, entrati:Array, usciti:Array, confermati:Array}}
 */
function aggiornaRegistro({ registro = {}, giudizi = [], ora = Date.now() } = {}) {
  const vecchio = (registro && typeof registro === 'object' && registro.voci) ? registro.voci : {};
  const voci = { ...vecchio };
  const entrati = [], usciti = [], confermati = [];
  for (const g of (Array.isArray(giudizi) ? giudizi : [])) {
    if (!g || !g.chiave) continue;
    const prec = voci[g.chiave] || null;
    // ⚠ NON GIUDICABILE NON E' «RECUPERABILE»: un libro illeggibile non deve poter cancellare una
    // conferma già maturata, o basterebbe un buco di feed per rimettere in gioco una posizione
    // abbandonata e ricominciare a bruciare tentativi. La voce resta com'è, e non avanza.
    if (g.giudizio && g.giudizio.giudicabile === false) continue;
    if (!g.giudizio || g.giudizio.abbandonabile !== true) {
      if (prec) { usciti.push({ ...prec, chiave: g.chiave, motivoUscita: g.giudizio ? g.giudizio.motivo : 'giudizio assente' }); delete voci[g.chiave]; }
      continue;
    }
    const contigua = prec && fin(prec.ultimaAt) && (ora - prec.ultimaAt) <= CONTIGUITA_MAX_MS;
    const osservazioni = contigua ? Number(prec.osservazioni || 0) + 1 : 1;
    const eraAbbandonata = !!(prec && prec.abbandonataDal != null);
    const abbandonata = osservazioni >= OSSERVAZIONI_PER_ABBANDONO;
    const voce = {
      marketId: String(g.marketId).toLowerCase(), tokenId: String(g.tokenId),
      book: g.book || null, size: g.size != null ? Number(g.size) : null,
      carico: g.carico != null ? Number(g.carico) : null,
      valoreResiduo: g.giudizio.valoreResiduo, costoUscita: g.giudizio.costoUscita,
      soglia: g.giudizio.soglia, causa: g.giudizio.causa, motivo: g.giudizio.motivo,
      osservazioni, primaAt: prec && contigua && fin(prec.primaAt) ? prec.primaAt : ora,
      ultimaAt: ora,
      abbandonataDal: abbandonata ? (eraAbbandonata && fin(prec.abbandonataDal) ? prec.abbandonataDal : ora) : null,
    };
    voci[g.chiave] = voce;
    if (abbandonata && !eraAbbandonata) entrati.push({ ...voce, chiave: g.chiave });
    else if (abbandonata) confermati.push({ ...voce, chiave: g.chiave });
  }
  return { registro: { v: 1, aggiornatoAt: ora, voci }, entrati, usciti, confermati };
}

/** Le sole voci CONFERMATE (armate ⇒ abbandonate). Una voce a una sola osservazione non conta. */
function abbandonate({ registro = {} } = {}) {
  const voci = (registro && registro.voci) || {};
  return Object.entries(voci)
    .filter(([, v]) => v && v.abbandonataDal != null)
    .map(([chiave, v]) => ({ chiave, ...v }));
}

/**
 * I MERCATI CHE POSSONO LIBERARE LO SLOT — e la condizione è più stretta di «ha una posizione
 * abbandonata».
 *
 * ⚠ SI LIBERA LO SLOT SOLO SE **OGNI** POSIZIONE DI QUEL MERCATO E' ABBANDONATA. Un mercato con una
 * gamba abbandonata e una viva sta ancora lavorando, e togliergli lo slot vorrebbe dire smettere di
 * gestirlo mentre ha capitale dentro. Fail-closed: registro illeggibile ⇒ insieme VUOTO ⇒ nessuno
 * slot si libera, cioè il comportamento di prima.
 *
 * @param {{registro:object, posizioni:Array<{conditionId:string, tokenId:string}>}} arg
 * @returns {Set<string>} conditionId (minuscoli) i cui slot possono essere liberati.
 */
function mercatiInteramenteAbbandonati({ registro = {}, posizioni = [] } = {}) {
  const out = new Set();
  if (!Array.isArray(posizioni) || !posizioni.length) return out;
  const abb = new Set(abbandonate({ registro }).map((v) => chiaveAbbandono(v.marketId, v.tokenId)));
  if (!abb.size) return out;
  const perMercato = new Map();
  for (const p of posizioni) {
    if (!p || !p.conditionId || !p.tokenId) continue;
    const cid = String(p.conditionId).toLowerCase();
    const v = perMercato.get(cid) || [];
    v.push(chiaveAbbandono(cid, p.tokenId));
    perMercato.set(cid, v);
  }
  for (const [cid, chiavi] of perMercato) {
    if (chiavi.length && chiavi.every((k) => abb.has(k))) out.add(cid);
  }
  return out;
}

/** Prove interne. Girano con `node lib/maker/abbandono-posizione.js`. */
function selfcheck() {
  let ok = true;
  const A = (nome, cond) => { if (!cond) { ok = false; console.error('  ✗ ' + nome); } else console.log('  ✓ ' + nome); };
  const liv = (price, size) => ({ price, size });

  // La soglia è DERIVATA, non scritta.
  A('la soglia è 5% del tetto per mercato', Math.abs(SOGLIA_ABBANDONO_USD - 0.05 * MARKET_CAP_FIXED_USD) < 1e-9);

  // Il caso reale del 23 agosto: Don't Say Good Luck.
  const dsgl = valutaAbbandono({ carico: 0.065, size: 56.1, sizeAltroLato: 0,
    bidsMioLato: [liv(0.03, 20), liv(0.027, 40)], asksAltroLato: [liv(0.97, 20), liv(0.973, 40)] });
  A('Don\'t Say Good Luck è abbandonabile', dsgl.abbandonabile === true);
  A('  e il valore residuo è sotto la soglia', dsgl.valoreResiduo < SOGLIA_ABBANDONO_USD);
  A('  e il costo d\'uscita supera il valore', dsgl.costoUscita >= dsgl.valoreResiduo);

  // Democratic House: vale troppo per essere abbandonata.
  const dem = valutaAbbandono({ carico: 0.494, size: 56.1, sizeAltroLato: 0,
    bidsMioLato: [liv(0.39, 200)], asksAltroLato: [liv(0.61, 200)] });
  A('Democratic House NON è abbandonabile', dem.abbandonabile === false && dem.causa === 'sopra-soglia');

  // Sotto soglia ma con un'uscita conveniente: non si abbandona.
  const conv = valutaAbbandono({ carico: 0.10, size: 20, sizeAltroLato: 0,
    bidsMioLato: [liv(0.099, 100)], asksAltroLato: [liv(0.901, 100)] });
  A('sotto soglia ma uscita conveniente ⇒ NON abbandonata',
    conv.abbandonabile === false && conv.causa === 'uscita-conveniente' && conv.valoreResiduo < SOGLIA_ABBANDONO_USD);

  // Le due vie coincidono quando ask = 1 − bid (il CLOB reale).
  A('costoVendita === costoCoppia quando ask = 1 − bid', Math.abs(dsgl.costoVendita - dsgl.costoCoppia) < 1e-6);
  A('il costo d\'uscita è il minimo delle due vie',
    Math.abs(dsgl.costoUscita - Math.min(dsgl.costoVendita, dsgl.costoCoppia)) < 1e-12);

  // La coppia batte l'abbandono.
  const coppia = valutaAbbandono({ carico: 0.065, size: 56.1, sizeAltroLato: 56.1,
    bidsMioLato: [liv(0.01, 100)], asksAltroLato: [liv(0.99, 100)] });
  A('coppia completa ⇒ mai abbandonata', coppia.abbandonabile === false && coppia.causa === 'coppia-completa');

  // Fail-closed su ogni ingresso.
  A('carico illeggibile ⇒ non giudicabile', valutaAbbandono({ carico: null, size: 10, sizeAltroLato: 0, bidsMioLato: [liv(0.01, 100)], asksAltroLato: [liv(0.99, 100)] }).giudicabile === false);
  A('sizeAltroLato non letta ⇒ non giudicabile', valutaAbbandono({ carico: 0.05, size: 10, bidsMioLato: [liv(0.01, 100)], asksAltroLato: [liv(0.99, 100)] }).giudicabile === false);
  A('bid che non copre l\'intera size ⇒ non giudicabile', valutaAbbandono({ carico: 0.05, size: 100, sizeAltroLato: 0, bidsMioLato: [liv(0.01, 10)], asksAltroLato: [liv(0.99, 200)] }).giudicabile === false);
  A('ask dell\'altro lato che non copre ⇒ non giudicabile', valutaAbbandono({ carico: 0.05, size: 100, sizeAltroLato: 0, bidsMioLato: [liv(0.01, 200)], asksAltroLato: [liv(0.99, 10)] }).giudicabile === false);

  // Il registro: due osservazioni per entrare, una per uscire.
  const g = (t) => ({ chiave: 'm|t', marketId: '0xaa', tokenId: 't', book: 'no', size: 56.1, carico: 0.065, giudizio: t });
  let r = aggiornaRegistro({ registro: {}, giudizi: [g(dsgl)], ora: 1000 });
  A('la prima osservazione ARMA soltanto', r.entrati.length === 0 && abbandonate({ registro: r.registro }).length === 0);
  r = aggiornaRegistro({ registro: r.registro, giudizi: [g(dsgl)], ora: 61000 });
  A('la seconda osservazione contigua abbandona', r.entrati.length === 1 && abbandonate({ registro: r.registro }).length === 1);
  const r2 = aggiornaRegistro({ registro: r.registro, giudizi: [g(dem)], ora: 121000 });
  A('una sola osservazione «recuperabile» fa rientrare', r2.usciti.length === 1 && abbandonate({ registro: r2.registro }).length === 0);
  // Non contigua ⇒ il contatore riparte.
  let rc = aggiornaRegistro({ registro: {}, giudizi: [g(dsgl)], ora: 1000 });
  rc = aggiornaRegistro({ registro: rc.registro, giudizi: [g(dsgl)], ora: 1000 + CONTIGUITA_MAX_MS + 1 });
  A('due osservazioni NON contigue non abbandonano', abbandonate({ registro: rc.registro }).length === 0);
  // Non giudicabile ⇒ la voce non avanza e non sparisce.
  const nonG = valutaAbbandono({ carico: null, size: 1, sizeAltroLato: 0 });
  const rg = aggiornaRegistro({ registro: r.registro, giudizi: [g(nonG)], ora: 121000 });
  A('un giudizio non giudicabile lascia la voce com\'è', abbandonate({ registro: rg.registro }).length === 1);

  // Lo slot si libera solo se OGNI posizione del mercato è abbandonata.
  const reg = aggiornaRegistro({ registro: aggiornaRegistro({ registro: {}, giudizi: [
    { chiave: chiaveAbbandono('0xaa', 't1'), marketId: '0xaa', tokenId: 't1', giudizio: dsgl }], ora: 1000 }).registro,
    giudizi: [{ chiave: chiaveAbbandono('0xaa', 't1'), marketId: '0xaa', tokenId: 't1', giudizio: dsgl }], ora: 61000 }).registro;
  A('mercato con UNA sola posizione, abbandonata ⇒ slot liberabile',
    mercatiInteramenteAbbandonati({ registro: reg, posizioni: [{ conditionId: '0xAA', tokenId: 't1' }] }).has('0xaa'));
  A('mercato con una gamba viva ⇒ slot NON liberabile',
    mercatiInteramenteAbbandonati({ registro: reg, posizioni: [{ conditionId: '0xAA', tokenId: 't1' }, { conditionId: '0xAA', tokenId: 't2' }] }).size === 0);
  A('registro vuoto ⇒ nessuno slot liberato (fail-closed)',
    mercatiInteramenteAbbandonati({ registro: {}, posizioni: [{ conditionId: '0xAA', tokenId: 't1' }] }).size === 0);

  return ok;
}

module.exports = {
  valutaAbbandono, aggiornaRegistro, abbandonate, mercatiInteramenteAbbandonati,
  camminaScala, chiaveAbbandono,
  SOGLIA_ABBANDONO_USD, OSSERVAZIONI_PER_ABBANDONO, CONTIGUITA_MAX_MS,
};

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

'use strict';
// lib/rewards/profondita-minima.js — LA PROFONDITÀ DEL BOOK COME LIMITE DI SIZE, PRIMA DEL KNAPSACK.
//
// ⚠ DALL'11 AGOSTO 2026 NON È PIÙ (SOLO) UN CANCELLO: è una SCALA. `scalaProfondita` — in fondo al file,
//   con la sua derivazione per intero — limita il capitale di un mercato a quanto il suo book assorbe
//   restando dentro la quota credibile, invece di toglierlo dal set. L'esclusione resta, ma solo dove
//   non esiste nessuna size piazzabile che regga. `verdettoProfondita` qui sotto NON è stato toccato:
//   continua a essere il verdetto al metro fisso di $500, che è il numero pubblicato sui candidati e
//   nel rendiconto. Il testo che segue è la storia del cancello, ed è ancora la ragione per cui il
//   limite esiste.
//
// ═══ IL FATTO DA CUI NASCE (9 agosto 2026) ═══════════════════════════════════════════════════════════
// Il piano vero del 9 agosto copriva il 99,0% del capitale libero — $588 su $594 — e lo faceva con NOVE
// mercati di cui SETTE avevano la quota tagliata da `maxCredibleShare` e DUE stavano su un book vuoto
// verificato. Sette righe su nove erano meteo asiatico misurato all'una-due di notte locale, cioè
// mercati in cui nessun altro stava quotando. Il piano dichiarava $697/giorno di lordo — il 67%
// dell'INTERO montepremi di quei mercati — e $259/giorno di «realistico» su $588 di capitale, cioè il
// 44% al giorno. Nessun maker incassa il 44% al giorno.
//
// Il board non conteneva qualche mercato sottile: il board ERA in maggioranza sottile. Misurato sulle
// 108 righe di quel giorno: 73 (68%) con quota modellata oltre il 60% a $500 di capitale, 98 con
// `thinBookFlag` già alzato dal venue-scanner, 99 con `sane500 === false`.
//
// ═══ PERCHÉ UN CANCELLO E NON (SOLO) UN'ATTENUAZIONE ════════════════════════════════════════════════
// `credibleShareFactor` esisteva già e faceva la cosa giusta a metà: taglia la quota a 0,60 ma lascia
// il mercato NEL SET dei candidati. Il knapsack MASSIMIZZA, quindi un mercato tagliato a 0,60 resta
// comunque più attraente di uno onesto al 5% — l'attenuazione riduce il numero senza togliere il
// mercato, e il mercato vince lo stesso. Il punto di applicazione era sbagliato, non la misura.
//
// La misura NON CAMBIA di una riga: è la stessa `ceilingShare(size, competitorQ)` di
// `realistic-estimate`, con la stessa soglia `maxCredibleShare`. Cambia solo QUANDO si guarda: prima
// della scelta invece che dentro l'obiettivo.
//
// ═══ COSA È STATO MISURATO PRIMA DI SCRIVERLO ═══════════════════════════════════════════════════════
// Quattro piani appaiati sullo stesso board e sullo stesso capitale ($594,10 liberi, tetto 20%):
//
//     scenario                          esclusi   allocato   copertura   quote capate   book vuoti
//     nessuna esclusione (com'era)            0    $588,00       99,0%           5/7            8
//     senza meteo notturno                   46    $588,00       99,0%           2/6            1
//     senza sottili (quota > 0,60)           73    $588,00       99,0%           0/5            0
//     senza notturni E sottili               78    $588,00       99,0%           0/5            0
//
// Togliendo il 72% del board la copertura resta IDENTICA AL CENTESIMO. La ragione è aritmetica: col
// tetto di concentrazione al 20% servono al minimo CINQUE mercati per coprire il capitale, e il pool
// superstite ne aveva TRENTA — sei volte il necessario. Questo cancello non può affamare il piano
// finché quel rapporto regge, e il referto lo pubblica a ogni ciclo perché smetta di essere un'ipotesi.
//
// ═══ LA SOGLIA NON È UN NUMERO NUOVO ════════════════════════════════════════════════════════════════
// È `realistic-estimate.DEFAULTS.maxCredibleShare` — la STESSA che l'attenuazione usa. Importata, non
// ridichiarata: due costanti per lo stesso concetto sono il difetto che il rilevatore D1 dell'audit
// cerca, e qui sarebbe particolarmente insidioso perché cancello e attenuazione devono per costruzione
// parlare dello stesso confine. Se un giorno si vorranno due soglie diverse — un cancello più largo
// dell'attenuazione — quella sarà una decisione da scrivere qui con la sua misura, non un default.
//
// ═══ E L'ATTENUAZIONE RESTA ═════════════════════════════════════════════════════════════════════════
// Chi supera il cancello continua a passare da `credibleShareFactor` esattamente come prima. Il cancello
// toglie i mercati la cui quota è INCREDIBILE al capitale di riferimento; l'attenuazione continua a
// correggere, livello per livello, chi diventa sottile solo alle size più grandi. Sono due domande
// diverse: «questo mercato è un book vero?» e «quanta di questa quota è credibile a QUESTA size?».

const { ceilingShare, DEFAULTS } = require('./realistic-estimate');

/** La soglia. NON è dichiarata qui: è la stessa dell'attenuazione, importata. */
const MAX_QUOTA_CREDIBILE = DEFAULTS.maxCredibleShare;

/** IL CAPITALE DI RIFERIMENTO SU CUI SI GIUDICA — $500, e il numero non è arbitrario.
 *
 *  È il livello su cui agent24 pubblica già `levels["500"].share` per ogni riga del board, cioè la
 *  grandezza con cui la diagnosi del 9 agosto ha contato i 73 mercati sottili. Giudicare a un capitale
 *  diverso da quello misurato vorrebbe dire che il filtro esclude un insieme che nessuno ha guardato.
 *
 *  PERCHÉ NON IL CAPITALE VERO DELLA RIGA. Le curve del knapsack si fermano al tetto di concentrazione
 *  (oggi ~$134): giudicare «alla size che riceverebbe» renderebbe la soglia dipendente dal capitale del
 *  conto, quindi lo STESSO mercato sarebbe sottile o no a seconda di quanto denaro c'è in cassa. La
 *  sottigliezza è una proprietà del BOOK, non del nostro conto, e va misurata a un metro fisso.
 *
 *  Si cambia con `MAKER_PROFONDITA_CAPITALE_RIF`; un valore illeggibile o ≤ 0 viene SCARTATO in favore
 *  del difetto — la stessa regola di fine scala e dell'orizzonte: un `.env` sbagliato non deve poter
 *  spostare in silenzio un cancello che decide dove va il capitale. */
const CAPITALE_RIFERIMENTO_USD_DEFAULT = 500;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

function capitaleRiferimento(env = process.env) {
  const raw = env && typeof env.MAKER_PROFONDITA_CAPITALE_RIF === 'string' ? env.MAKER_PROFONDITA_CAPITALE_RIF.trim() : '';
  if (!raw) return CAPITALE_RIFERIMENTO_USD_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return CAPITALE_RIFERIMENTO_USD_DEFAULT;
  return v;
}

/**
 * Il verdetto sulla profondità di UN mercato.
 *
 * @param {object} a
 *   sharePerUsd   share per dollaro di capitale su questo mercato (dalla curva: sizePerSideShares/capital)
 *   depthShares   la concorrenza in banda MISURATA, in share (marketMeta().depthShares)
 *   capitaleRiferimentoUsd  di difetto `capitaleRiferimento()`
 *   maxQuota      di difetto `MAX_QUOTA_CREDIBILE`
 * @returns {{stato:'ok'|'sottile'|'ignota', quota:number|null, soglia:number, capitaleRif:number, motivo:string}}
 *
 *   'sottile' ⇒ ESCLUDE dal set passato al knapsack
 *   'ok'      ⇒ passa il cancello, e l'attenuazione continua ad agire su di lui come prima
 *   'ignota'  ⇒ NON ESCLUDE MAI. Un dato mancante non è un book vuoto: è la stessa regola che
 *               `horizonVerdict` applica a una scadenza illeggibile e che `marketValidity` applica a
 *               un montepremi non letto. L'assenza di un fatto non indossa i panni del fatto.
 */
function verdettoProfondita(a = {}) {
  const { sharePerUsd, depthShares } = a;
  const soglia = fin(a.maxQuota) && a.maxQuota > 0 && a.maxQuota < 1 ? a.maxQuota : MAX_QUOTA_CREDIBILE;
  const capitaleRif = fin(a.capitaleRiferimentoUsd) && a.capitaleRiferimentoUsd > 0
    ? a.capitaleRiferimentoUsd : capitaleRiferimento(a.env || process.env);

  if (!fin(sharePerUsd) || sharePerUsd <= 0) {
    return { stato: 'ignota', quota: null, soglia, capitaleRif, motivo: 'size per dollaro non calcolabile (costo della coppia o mid non leggibili) — non si conclude che il book sia sottile' };
  }
  if (!fin(depthShares) || depthShares < 0) {
    return { stato: 'ignota', quota: null, soglia, capitaleRif, motivo: 'profondità in banda non misurata — non si conclude che il book sia sottile' };
  }
  const quota = ceilingShare(sharePerUsd * capitaleRif, depthShares);
  if (quota == null) {
    return { stato: 'ignota', quota: null, soglia, capitaleRif, motivo: 'quota non calcolabile dagli ingressi letti' };
  }
  if (quota > soglia) {
    return {
      stato: 'sottile', quota, soglia, capitaleRif,
      motivo: `a $${capitaleRif} di capitale il modello attribuirebbe il ${(quota * 100).toFixed(1)}% del montepremi `
        + `(concorrenza in banda ${depthShares.toFixed(0)} share): oltre la quota massima credibile del ${(soglia * 100).toFixed(0)}%. `
        + 'Una quota così alta non è un\'opportunità — è un book in cui non c\'è nessun altro, e comprime appena arriva chiunque',
    };
  }
  return { stato: 'ok', quota, soglia, capitaleRif, motivo: `quota ${(quota * 100).toFixed(1)}% a $${capitaleRif}, sotto la soglia del ${(soglia * 100).toFixed(0)}%` };
}

/** Vero solo per un verdetto che ESCLUDE. Esiste perché chi chiama non debba confrontare stringhe. */
function esclude(v) { return !!v && v.stato === 'sottile'; }

// ═══ DA CANCELLO A SCALA — 11 agosto 2026 ═════════════════════════════════════════════════════════════
//
// Il cancello qui sopra risponde SÌ/NO a un metro fisso di $500. La domanda giusta non è «questo book è
// sottile a $500?» ma «quanto capitale regge questo book restando dentro la quota credibile?», e le due
// coincidono solo per caso.
//
// ─── PERCHÉ IL METRO FISSO ERA GIUSTO ALLORA E NON LO È PIÙ ──────────────────────────────────────────
// L'intestazione di `CAPITALE_RIFERIMENTO_USD_DEFAULT` dice, testualmente: «giudicare alla size che
// riceverebbe renderebbe la soglia dipendente dal capitale del conto, quindi lo STESSO mercato sarebbe
// sottile o no a seconda di quanto denaro c'è in cassa». Era vero il 9 agosto, quando il tetto per
// mercato era il 20% del capitale. Dal 9 agosto sera il tetto è un NUMERO FISSO in dollari
// (`concentration.MARKET_CAP_FIXED_USD`, oggi $65) e dall'11 agosto non dipende più dal saldo in nessun
// modo: giudicare alla size vera è oggi esattamente altrettanto metro-fisso che giudicare a $500, e in
// più è la size che il capitale prenderebbe davvero. L'obiezione è caduta con la costante che la
// motivava, e questo modulo la sostituisce invece di aggirarla.
//
// ─── L'ARITMETICA, PER INTERO ────────────────────────────────────────────────────────────────────────
// La quota modellata di un ordine da S share contro cQ share di concorrenza in banda è `S/(S+cQ)`
// (`ceilingShare`). Imporre `S/(S+cQ) ≤ q` dà
//
//     S ≤ cQ · q/(1−q)          con q = 0,60  ⇒  S_max = 1,5 · cQ
//
// cioè la size massima che resta dentro la quota credibile è una proprietà del solo book. Convertirla in
// dollari NON richiede una seconda formula: ogni livello della curva porta già la sua size in share
// accanto al suo capitale, quindi si tengono i livelli la cui size supera l'esame e si buttano gli altri.
// Nessuna estrapolazione lineare, nessun secondo modello capitale→share da tenere allineato al primo.
//
// ─── LE QUATTRO REGOLE, E PERCHÉ STANNO TUTTE QUI ────────────────────────────────────────────────────
//  1. size effettiva = min(tetto per mercato, capitale che il book assorbe entro la quota sicura).
//     Il «tetto per mercato» NON è dichiarato qui: è `maxPerMarketUsd`, che il chiamante applica già ai
//     livelli della curva prima di passarli. Ridichiararlo sarebbe la quinta copia della stessa costante
//     — il reperto che il rilevatore D1 cerca — e questo modulo non deve conoscere il conto.
//  2. se nemmeno la size minima del venue sta dentro la quota sicura, il mercato ESCE: non esiste una
//     size piazzabile che regga, quindi non c'è niente da scalare.
//  3. se una size sicura ≥ minimo esiste in teoria ma nessun livello finanziabile ci finisce dentro
//     (la griglia del knapsack è discreta), il mercato ESCE anche lì — con un motivo diverso, perché
//     è un limite della griglia e non del book.
//  4. VINCOLO ASSOLUTO: non esiste nessun ramo che rimetta dentro un livello oltre la quota sicura per
//     «arrivare almeno al minimo». È il difetto che un test affrettato non vede, perché produrrebbe un
//     piano apparentemente sano — un mercato in più, size 20 share — costruito sull'ottimismo che questo
//     modulo esiste per togliere. La garanzia è STRUTTURALE: `tenuti` si calcola una volta sola, prima
//     di sapere se qualcosa resterà, e i due rami di esclusione lo restituiscono senza toccarlo.
//
// ─── E LA REGOLA CARDINALE NON CAMBIA ────────────────────────────────────────────────────────────────
// Profondità non misurata ⇒ non si scala e non si esclude. L'assenza di un fatto non indossa i panni del
// fatto, qui come in `horizonVerdict`. Un livello finanziato la cui size non è leggibile viene invece
// TOLTO — non può essere verificato, e toglierlo può solo ridurre l'esposizione, mai allargarla; ma se
// nessun livello finanziato è verificabile si torna a `ignota` e il mercato resta intatto, perché a quel
// punto sarebbe il dato mancante a escludere il mercato.

/** La size massima (in share, per lato) che resta dentro la quota `soglia` contro `depthShares`. */
function sizeMassimaSicura(depthShares, soglia = MAX_QUOTA_CREDIBILE) {
  if (!fin(depthShares) || depthShares < 0) return null;
  const q = fin(soglia) && soglia > 0 && soglia < 1 ? soglia : MAX_QUOTA_CREDIBILE;
  return depthShares * q / (1 - q);
}

/**
 * LA SCALA: quali livelli di una curva restano dentro la quota credibile, e se ne resta abbastanza.
 *
 * @param {object} a
 *   livelli       [{ capital, shares, finanziato, sottoMinimoVenue }] — vocabolario GENERICO, non «curva»:
 *                 il modulo resta puro e non impara la forma interna dell'allocatore.
 *   depthShares   concorrenza in banda MISURATA, in share
 *   minSizeShares minimo del venue per QUESTO mercato (20/50/100/200 sul board vero), o null
 *   maxQuota      di difetto `MAX_QUOTA_CREDIBILE`
 * @returns {{stato:'ok'|'ridotto'|'escluso-troppo-sottile'|'escluso-sotto-minimo'|'ignota',
 *            tenuti:boolean[], soglia:number, sizeMaxSicuraShares:number|null,
 *            capitaleMaxUsd:number|null, quotaPiena:number|null, quotaTenuta:number|null,
 *            finanziatiTenuti:number, finanziatiTolti:number, motivo:string}}
 */
function scalaProfondita(a = {}) {
  const soglia = fin(a.maxQuota) && a.maxQuota > 0 && a.maxQuota < 1 ? a.maxQuota : MAX_QUOTA_CREDIBILE;
  const livelli = Array.isArray(a.livelli) ? a.livelli : [];
  const tuttiTenuti = livelli.map(() => true);
  const base = {
    tenuti: tuttiTenuti, soglia, sizeMaxSicuraShares: null, capitaleMaxUsd: null,
    quotaPiena: null, quotaTenuta: null, finanziatiTenuti: 0, finanziatiTolti: 0,
  };
  const depthShares = a.depthShares;
  if (!fin(depthShares) || depthShares < 0) {
    return { ...base, stato: 'ignota', motivo: 'profondità in banda non misurata — la size non viene scalata e il mercato non viene escluso' };
  }
  const sizeMax = sizeMassimaSicura(depthShares, soglia);

  const idxFin = [];
  for (let i = 0; i < livelli.length; i += 1) if (livelli[i] && livelli[i].finanziato) idxFin.push(i);
  if (!idxFin.length) {
    return { ...base, stato: 'ok', sizeMaxSicuraShares: sizeMax, motivo: 'nessun livello finanziabile: non c\'è size da scalare' };
  }
  const verificabili = idxFin.filter((i) => fin(livelli[i].shares) && livelli[i].shares > 0);
  if (!verificabili.length) {
    return { ...base, stato: 'ignota', sizeMaxSicuraShares: sizeMax, motivo: 'nessun livello finanziato porta una size leggibile — non si conclude niente sul book' };
  }

  // ── L'UNICO PUNTO IN CUI SI DECIDE COSA RESTA. Si calcola PRIMA di sapere se resterà qualcosa, ed è
  //    la forma che rende il vincolo 4 strutturale invece che promesso: non c'è nessun «altrimenti».
  const tenuti = livelli.map((l) => {
    if (!l || !l.finanziato) return true;                       // livello zero e non finanziati: intatti
    if (!fin(l.shares) || l.shares <= 0) return false;          // finanziato ma non verificabile: si toglie
    const q = ceilingShare(l.shares, depthShares);
    if (q == null) return false;
    return !(q > soglia);                                        // confine INCLUSIVO, come il cancello
  });

  const quotaDi = (i) => ceilingShare(livelli[i].shares, depthShares);
  const piuGrande = (lista) => lista.reduce((best, i) => (best == null || livelli[i].shares > livelli[best].shares ? i : best), null);
  const idxPiena = piuGrande(verificabili);
  const quotaPiena = idxPiena == null ? null : quotaDi(idxPiena);

  const tenutiFin = idxFin.filter((i) => tenuti[i]);
  const utilizzabili = tenutiFin.filter((i) => livelli[i].sottoMinimoVenue !== true && fin(livelli[i].shares));
  const finanziatiTolti = idxFin.length - tenutiFin.length;

  // ── LA PROFONDITÀ PARLA SOLO QUANDO LEGA DAVVERO ────────────────────────────────────────────────
  // Se nessun livello finanziabile è stato tolto, questo book regge tutto ciò che il tetto per mercato
  // concede: qualunque altra ragione per cui il mercato non entra — tipicamente il minimo del venue
  // contro un tetto che non ci arriva — è di qualcun altro, e va lasciata dire a chi la misura.
  //
  // MISURATO, e la prima stesura sbagliava proprio qui: sul board dell'11 agosto la versione che
  // escludeva anche senza aver tagliato niente si prendeva la diagnosi di VENTOTTO mercati che il
  // minimo del venue teneva fuori da sempre, li toglieva PRIMA del knapsack invece di lasciarli
  // scorare zero, e falsava il rapporto superstiti/minimi che è ciò che rende la scala sicura.
  if (!finanziatiTolti) {
    const idxLibero = utilizzabili.length ? piuGrande(utilizzabili) : null;
    return {
      ...base, tenuti, sizeMaxSicuraShares: sizeMax, quotaPiena,
      quotaTenuta: idxLibero == null ? null : quotaDi(idxLibero),
      capitaleMaxUsd: idxLibero != null && fin(livelli[idxLibero].capital) ? livelli[idxLibero].capital : null,
      finanziatiTenuti: tenutiFin.length, finanziatiTolti: 0,
      stato: 'ok',
      motivo: `il book regge fino a ${sizeMax.toFixed(1)} share: nessun livello finanziabile supera il ${(soglia * 100).toFixed(0)}%, la size non viene scalata`,
    };
  }

  if (!utilizzabili.length) {
    // Regola 2 contro regola 3: il pavimento è il minimo del VENUE quando è noto — è la size sotto la
    // quale un ordine non matura reward — e altrimenti la size finanziabile più piccola della griglia.
    const minVenue = fin(a.minSizeShares) && a.minSizeShares > 0 ? a.minSizeShares : null;
    const minGriglia = Math.min.apply(null, verificabili.map((i) => livelli[i].shares));
    const pavimento = minVenue != null ? minVenue : minGriglia;
    const troppoSottile = fin(sizeMax) && pavimento > sizeMax;
    return {
      ...base, tenuti, sizeMaxSicuraShares: sizeMax, quotaPiena,
      finanziatiTenuti: tenutiFin.length, finanziatiTolti,
      stato: troppoSottile ? 'escluso-troppo-sottile' : 'escluso-sotto-minimo',
      motivo: troppoSottile
        ? `con ${depthShares.toFixed(0)} share di concorrenza in banda la size massima che resta entro il ${(soglia * 100).toFixed(0)}% `
          + `è ${sizeMax.toFixed(1)} share, sotto ${minVenue != null ? `il minimo del venue (${minVenue.toFixed(0)} share)` : `la size finanziabile più piccola (${minGriglia.toFixed(1)} share)`}: `
          + 'nessuna size piazzabile regge questo book, quindi non c\'è niente da scalare'
        : `una size sicura esiste (fino a ${sizeMax.toFixed(1)} share entro il ${(soglia * 100).toFixed(0)}%) ma nessun livello finanziabile ci finisce dentro `
          + `restando sopra il minimo del venue${minVenue != null ? ` (${minVenue.toFixed(0)} share)` : ''}: è la griglia del capitale a non avere un gradino utile, non il book a essere deserto`,
    };
  }

  const idxTenuto = piuGrande(utilizzabili);
  const capitaleMaxUsd = fin(livelli[idxTenuto].capital) ? livelli[idxTenuto].capital : null;
  const quotaTenuta = quotaDi(idxTenuto);
  return {
    ...base, tenuti, sizeMaxSicuraShares: sizeMax, capitaleMaxUsd, quotaPiena, quotaTenuta,
    finanziatiTenuti: tenutiFin.length, finanziatiTolti,
    stato: 'ridotto',
    motivo: `capitale limitato a $${capitaleMaxUsd == null ? '?' : capitaleMaxUsd.toFixed(2)} su questo mercato: oltre, la quota modellata supererebbe il ${(soglia * 100).toFixed(0)}% `
      + `(concorrenza in banda ${depthShares.toFixed(0)} share ⇒ al più ${sizeMax.toFixed(1)} share per lato). `
      + `Al livello tenuto la quota è ${quotaTenuta == null ? '?' : (quotaTenuta * 100).toFixed(1)}%, contro il ${quotaPiena == null ? '?' : (quotaPiena * 100).toFixed(1)}% che il livello pieno dichiarava`,
  };
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/profondita-minima').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  // ── la soglia è IMPORTATA, non ridichiarata
  ok('la soglia è la stessa dell\'attenuazione (nessuna seconda costante)',
    MAX_QUOTA_CREDIBILE === require('./realistic-estimate').DEFAULTS.maxCredibleShare);
  ok('  e vale 0,60 come il tetto di credibilità', Math.abs(MAX_QUOTA_CREDIBILE - 0.60) < 1e-9);
  ok('il capitale di riferimento di difetto è $500', capitaleRiferimento({}) === 500);

  // ── il caso che ha motivato il filtro: book deserto
  const deserto = verdettoProfondita({ sharePerUsd: 2, depthShares: 0 });
  ok('concorrenza ZERO → quota 100% → sottile', deserto.stato === 'sottile' && deserto.quota === 1);
  const quasiDeserto = verdettoProfondita({ sharePerUsd: 2, depthShares: 20 });
  ok('concorrenza 20 share contro 1000 nostre → sottile', quasiDeserto.stato === 'sottile');

  // ── il caso che deve passare: book vero
  const vero = verdettoProfondita({ sharePerUsd: 2, depthShares: 100_000 });
  ok('book profondo → ok, e la quota è piccola', vero.stato === 'ok' && vero.quota < 0.02);

  // ── il confine, e si comporta come gli altri confini del repo: si passa ALLA soglia
  const alConfine = verdettoProfondita({ sharePerUsd: 1, depthShares: 500 * (1 - 0.60) / 0.60 });
  ok('quota ESATTAMENTE alla soglia → passa (confine inclusivo, come MIN/MAX_HORIZON_DAYS)',
    alConfine.stato === 'ok' && Math.abs(alConfine.quota - 0.60) < 1e-9);
  const soprail = verdettoProfondita({ sharePerUsd: 1, depthShares: 500 * (1 - 0.61) / 0.61 });
  ok('  un soffio sopra la soglia → sottile', soprail.stato === 'sottile');

  // ── LA REGOLA CARDINALE: ignoto non esclude MAI
  ok('profondità non misurata → ignota, MAI sottile',
    verdettoProfondita({ sharePerUsd: 2, depthShares: null }).stato === 'ignota');
  ok('size per dollaro non calcolabile → ignota, MAI sottile',
    verdettoProfondita({ sharePerUsd: null, depthShares: 0 }).stato === 'ignota');
  ok('  e `esclude` è falso su entrambe',
    !esclude(verdettoProfondita({ sharePerUsd: 2, depthShares: null }))
    && !esclude(verdettoProfondita({ sharePerUsd: null, depthShares: 0 })));
  ok('NaN e stringhe non passano per numeri',
    verdettoProfondita({ sharePerUsd: NaN, depthShares: 0 }).stato === 'ignota'
    && verdettoProfondita({ sharePerUsd: '2', depthShares: 0 }).stato === 'ignota'
    && verdettoProfondita({ sharePerUsd: 2, depthShares: -1 }).stato === 'ignota');

  // ── il metro è FISSO: non dipende dal capitale del conto
  const a1 = verdettoProfondita({ sharePerUsd: 2, depthShares: 5_000 });
  const a2 = verdettoProfondita({ sharePerUsd: 2, depthShares: 5_000, capitaleRiferimentoUsd: 500 });
  ok('lo stesso mercato dà lo stesso verdetto a prescindere da chi chiama', a1.stato === a2.stato && a1.quota === a2.quota);
  const grande = verdettoProfondita({ sharePerUsd: 2, depthShares: 5_000, capitaleRiferimentoUsd: 5_000 });
  ok('  ma a un riferimento più grande la stessa profondità sembra più sottile (monotòno)', grande.quota > a1.quota);

  // ── un env assurdo non sposta il cancello
  ok('env illeggibile → si torna al difetto', capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: 'tantissimo' }) === 500);
  ok('env negativo o zero → si torna al difetto',
    capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: '-1' }) === 500
    && capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: '0' }) === 500);
  ok('env valido → si usa', capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: '250' }) === 250);

  // ── una soglia fuori da (0,1) viene scartata, non applicata
  ok('soglia assurda scartata in favore di quella importata',
    verdettoProfondita({ sharePerUsd: 2, depthShares: 0, maxQuota: 5 }).soglia === MAX_QUOTA_CREDIBILE);

  // ══ LA SCALA ═══════════════════════════════════════════════════════════════════════════════════════
  // La griglia di prova: un mercato a mid 0,50 con costo coppia 0,98 compra ~1,02 share per dollaro di
  // capitale di MERCATO (YES+NO), cioè i numeri veri del board — $65 di tetto ⇒ 66,3 share per lato.
  const SPU = 66.3 / 65;                                   // share per lato, per dollaro di capitale
  const griglia = (capMax, passo = 5, minS = 20) => {
    const out = [{ capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false }];
    for (let c = passo; c <= capMax + 1e-9; c += passo) {
      const sh = c * SPU;
      out.push({ capital: +c.toFixed(2), shares: sh, finanziato: true, sottoMinimoVenue: sh < minS });
    }
    return out;
  };

  ok('S_max = cQ · q/(1−q) — e alla soglia la quota vale ESATTAMENTE la soglia', (() => {
    const cQ = 100, sm = sizeMassimaSicura(cQ);
    return Math.abs(sm - 150) < 1e-9 && Math.abs(ceilingShare(sm, cQ) - MAX_QUOTA_CREDIBILE) < 1e-12;
  })());
  ok('profondità non misurata → ignota, nessun livello tolto', (() => {
    const r = scalaProfondita({ livelli: griglia(65), depthShares: null, minSizeShares: 20 });
    return r.stato === 'ignota' && r.tenuti.every(Boolean);
  })());
  ok('book profondo → ok, il tetto per mercato resta l\'unico limite', (() => {
    const r = scalaProfondita({ livelli: griglia(65), depthShares: 40_000, minSizeShares: 20 });
    return r.stato === 'ok' && r.finanziatiTolti === 0 && Math.abs(r.capitaleMaxUsd - 65) < 1e-9;
  })());
  ok('REGOLA 1 · book intermedio → RIDOTTO, e il capitale tenuto sta dentro la quota', (() => {
    const cQ = 30;                                          // S_max = 45 share ⇒ ~$44 di capitale
    const r = scalaProfondita({ livelli: griglia(65), depthShares: cQ, minSizeShares: 20 });
    return r.stato === 'ridotto' && r.capitaleMaxUsd < 65 && r.capitaleMaxUsd > 0
      && ceilingShare(r.capitaleMaxUsd * SPU, cQ) <= MAX_QUOTA_CREDIBILE + 1e-12
      && r.quotaPiena > MAX_QUOTA_CREDIBILE;
  })());
  ok('  e il capitale tenuto è il PIÙ GRANDE che ci sta, non uno qualsiasi', (() => {
    const cQ = 30, r = scalaProfondita({ livelli: griglia(65), depthShares: cQ, minSizeShares: 20 });
    const prossimo = r.capitaleMaxUsd + 5;                  // il gradino successivo della griglia
    return ceilingShare(prossimo * SPU, cQ) > MAX_QUOTA_CREDIBILE;
  })());
  ok('REGOLA 2 · nemmeno il minimo del venue ci sta → escluso-troppo-sottile', (() => {
    const r = scalaProfondita({ livelli: griglia(65), depthShares: 10, minSizeShares: 20 });
    return r.stato === 'escluso-troppo-sottile' && r.capitaleMaxUsd === null;  // S_max = 15 < 20
  })());
  ok('  book VUOTO verificato (cQ = 0) → escluso, come faceva il cancello', (() => {
    const r = scalaProfondita({ livelli: griglia(65), depthShares: 0, minSizeShares: 20 });
    return r.stato === 'escluso-troppo-sottile' && r.sizeMaxSicuraShares === 0;
  })());
  ok('REGOLA 3 · size sicura ≥ minimo esiste ma nessun gradino ci finisce → escluso-sotto-minimo', (() => {
    // S_max = 33 share: sopra il minimo 20, ma la griglia salta da 0 a 40,8 share ($40)
    const livelli = [
      { capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false },
      { capital: 40, shares: 40 * SPU, finanziato: true, sottoMinimoVenue: false },
      { capital: 65, shares: 65 * SPU, finanziato: true, sottoMinimoVenue: false },
    ];
    const r = scalaProfondita({ livelli, depthShares: 22, minSizeShares: 20 });
    return r.stato === 'escluso-sotto-minimo' && r.sizeMaxSicuraShares > 20;
  })());
  ok('  e i soli gradini SICURI sotto il minimo del venue → escluso-sotto-minimo, non tenuti', (() => {
    // S_max = 30 share (cQ 20). Il solo gradino sicuro è $10 = 10,2 share, sotto il minimo di 20:
    // quello da $40 sarebbe abbastanza grande ma sfonda la quota. Non si tiene né l'uno né l'altro.
    const livelli = [
      { capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false },
      { capital: 10, shares: 10 * SPU, finanziato: true, sottoMinimoVenue: true },
      { capital: 40, shares: 40 * SPU, finanziato: true, sottoMinimoVenue: false },
    ];
    const r = scalaProfondita({ livelli, depthShares: 20, minSizeShares: 20 });
    return r.stato === 'escluso-sotto-minimo' && r.capitaleMaxUsd === null
      && r.tenuti[2] === false;                              // il gradino grande NON viene ripescato
  })());
  ok('REGOLA 4 · NESSUN livello oltre la quota sicura sopravvive, in NESSUNO stato', (() => {
    for (const cQ of [0, 3, 10, 14, 22, 30, 60, 200, 5_000]) {
      for (const minS of [20, 50, 100, 200, null]) {
        const livelli = griglia(65);
        const r = scalaProfondita({ livelli, depthShares: cQ, minSizeShares: minS });
        for (let i = 0; i < livelli.length; i += 1) {
          if (!r.tenuti[i] || !livelli[i].finanziato) continue;
          const q = ceilingShare(livelli[i].shares, cQ);
          if (q != null && q > MAX_QUOTA_CREDIBILE + 1e-12) return false;
        }
      }
    }
    return true;
  })());
  ok('REGOLA 4 · e in particolare NON si forza il minimo del venue quando sfonda la quota', (() => {
    const livelli = griglia(65);
    const r = scalaProfondita({ livelli, depthShares: 10, minSizeShares: 20 });  // S_max = 15 < 20
    const tenutoAlMinimo = livelli.some((l, i) => r.tenuti[i] && l.finanziato && l.shares >= 20);
    return r.stato === 'escluso-troppo-sottile' && !tenutoAlMinimo;
  })());
  ok('il minimo del venue è PER MERCATO: dove 20 riduce, 100 esclude', (() => {
    // cQ 45 ⇒ S_max 67,5 share. Su una griglia che arriva a $100 (102 share) i gradini alti vengono
    // tolti in entrambi i casi; con minimo 20 resta un gradino utilizzabile, con minimo 100 no —
    // ed è REGOLA 2, non un limite della griglia: 100 share contro 45 sono il 69% del montepremi.
    const cQ = 45;
    const a20 = scalaProfondita({ livelli: griglia(100, 5, 20), depthShares: cQ, minSizeShares: 20 });
    const a100 = scalaProfondita({ livelli: griglia(100, 5, 100), depthShares: cQ, minSizeShares: 100 });
    return a20.stato === 'ridotto' && a100.stato === 'escluso-troppo-sottile';
  })());
  ok('LA PROFONDITÀ NON RUBA LA DIAGNOSI: nessun taglio ⇒ `ok`, anche se tutto è sotto il minimo', (() => {
    // Book profondissimo: la scala non toglie niente. I livelli stanno tutti sotto il minimo di 100
    // perché il TETTO PER MERCATO non ci arriva — è un fatto del minimo del venue, non del book, e
    // deve restare al meccanismo che lo misura (`belowMinSize`).
    const r = scalaProfondita({ livelli: griglia(65, 5, 100), depthShares: 40_000, minSizeShares: 100 });
    return r.stato === 'ok' && r.finanziatiTolti === 0 && r.tenuti.every(Boolean);
  })());
  ok('un livello finanziato con size illeggibile viene TOLTO (può solo ridurre)', (() => {
    const livelli = griglia(65);
    livelli[livelli.length - 1] = { ...livelli[livelli.length - 1], shares: null };
    const r = scalaProfondita({ livelli, depthShares: 40_000, minSizeShares: 20 });
    return r.tenuti[livelli.length - 1] === false && r.stato === 'ridotto';
  })());
  ok('  ma se NESSUN livello è verificabile si torna a ignota, e il mercato resta intatto', (() => {
    const livelli = griglia(65).map((l) => (l.finanziato ? { ...l, shares: null } : l));
    const r = scalaProfondita({ livelli, depthShares: 40_000, minSizeShares: 20 });
    return r.stato === 'ignota' && r.tenuti.every(Boolean);
  })());
  ok('il livello zero non viene mai tolto: il knapsack ne ha bisogno', (() => {
    for (const cQ of [0, 5, 50, 10_000]) {
      const r = scalaProfondita({ livelli: griglia(65), depthShares: cQ, minSizeShares: 20 });
      if (r.tenuti[0] !== true) return false;
    }
    return true;
  })());
  ok('la soglia della scala è la STESSA del cancello (nessuna seconda costante)',
    scalaProfondita({ livelli: griglia(65), depthShares: 100 }).soglia === MAX_QUOTA_CREDIBILE
    && scalaProfondita({ livelli: griglia(65), depthShares: 100, maxQuota: 5 }).soglia === MAX_QUOTA_CREDIBILE);
  ok('monotòno: più concorrenza ⇒ capitale tenuto non minore', (() => {
    let prec = -1;
    for (const cQ of [20, 30, 45, 80, 200, 5_000]) {
      const r = scalaProfondita({ livelli: griglia(65), depthShares: cQ, minSizeShares: 20 });
      const c = r.capitaleMaxUsd == null ? 0 : r.capitaleMaxUsd;
      if (c < prec - 1e-9) return false;
      prec = c;
    }
    return true;
  })());

  console.log('profondita-minima: ' + n + ' assertions passed');
  return n;
}

module.exports = {
  MAX_QUOTA_CREDIBILE, CAPITALE_RIFERIMENTO_USD_DEFAULT,
  capitaleRiferimento, verdettoProfondita, esclude,
  sizeMassimaSicura, scalaProfondita,
  selfcheck,
};

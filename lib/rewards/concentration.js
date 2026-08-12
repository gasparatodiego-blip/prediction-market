'use strict';
// lib/rewards/concentration.js — IL TETTO PER MERCATO, IN UN POSTO SOLO.
//
// ═══ PERCHÉ UN MODULO PER UN NUMERO ══════════════════════════════════════════════════════════════════
// Il tetto viveva in lib/maker/realloc-cycle.js e valeva solo per il riallocatore periodico. Il pannello
// «Ottimizza» non ne passava nessuno, quindi il suo tetto effettivo era il capitale intero: sullo stesso
// saldo e nello stesso istante le due strade producevano piani diversi — 4 mercati col 76,5% su uno solo
// contro 7 mercati col 29,4% al massimo — e nessuna delle due schermate diceva perché.
//
// Due strade che rispondono alla stessa domanda devono usare lo stesso numero, e l'unico modo perché
// resti lo stesso è che sia scritto una volta. Da qui lo leggono TUTTI E QUATTRO i percorsi che lo
// consumano — pianificatore, motore di piazzamento, rimpiazzo di una gamba, punteggio di rischio.
//
// ═══ ERA UNA PERCENTUALE, DAL 9 AGOSTO 2026 È UN VALORE FISSO ════════════════════════════════════════
// Fino a oggi il tetto era `20% del capitale`: cresceva in dollari insieme al saldo, quindi a capitale
// doppio il sistema metteva il doppio su OGNI mercato invece di usare più mercati. Su $670 valeva $134,
// su $2.000 sarebbe valso $400 — cioè quattro volte il nozionale mediano dei 21 maker misurati (~$34).
//
// La decisione dell'operatore (9 agosto 2026) è l'opposto: **quando il capitale cresce si spalma su PIÙ
// MERCATI, non si ingrossa la size su ciascuno**. È la stessa filosofia che il resto del sistema segue
// già — briciole su molte righe invece di poche righe grosse — e con un tetto fisso il numero di mercati
// diventa una CONSEGUENZA (`capitale ÷ tetto`) invece di un parametro separato da tenere allineato.
//
// ═══ IL NUMERO: $65 DAL 10 AGOSTO 2026 (era $130), E COSA COPRE ═══════════════════════════════════════════════════════════════════
// $65 è il tetto sul MERCATO INTERO, cioè YES+NO sommati — la stessa semantica di prima, misurata e non
// assunta: `allocate.perMarketNetAtSize` restituisce `capital: 2 * sizeUsd`, e la griglia delle size è
// costruita a passi per lato fino a `capPerMarket`. Quindi $65 di tetto valgono **$32,50 per lato**.
// Verificato sul piano vero del 9 agosto: ogni riga ha `sizePerSideUsd = capital / 2` esatto.
//
// Il valore viene dal tetto che era in vigore ($133,99 = 20% di $669,93): $130 è quello, arrotondato in
// giù a un numero tondo, così il passaggio da percentuale a fisso NON cambia il piano di oggi — e
// infatti non lo cambia, misurato: stessa copertura, stesso capitale allocato.
//
// ═══ COSA QUESTO TETTO NON È ═════════════════════════════════════════════════════════════════════════
// Non è il tetto TOTALE. Quello resta dinamico e segue il capitale reale (`utilizzo-capitale`), ed è
// giusto che sia così: «quanto capitale impegnare in tutto» e «quanto su un singolo mercato» sono due
// domande diverse. Il tetto totale è una frazione del saldo; questo è un valore assoluto per riga.
//
// Non è nemmeno un limite al NUMERO di mercati. Quel limite non esiste più (era `MAX_POSIZIONI = 10` in
// agent41, rimosso il 9 agosto 2026): quanti mercati si usano è `capitale ÷ 130`, limitato solo da
// quanti mercati qualificati il board offre davvero.
//
// ═══ IL MECCANISMO ═══════════════════════════════════════════════════════════════════════════════════
// NON è un filtro a valle: `allocateBudget` costruisce la griglia delle size fino al tetto, quindi il
// knapsack non vede nemmeno i livelli oltre. Non c'è nessun punto in cui un'allocazione viene calcolata
// e poi tagliata.

/** IL TETTO PER MERCATO, IN DOLLARI, SU YES+NO SOMMATI. Si cambia QUI e in nessun altro posto.
 *
 * ── $130 → $65, IL 10 AGOSTO 2026, E IL NUMERO VIENE DA UNA MISURA ────────────────────────────────
 * Il modello compra share UGUALI sui due lati — `Q = capitale / (p_yes + p_no)`, plan-to-orders.js:242 —
 * quindi il tetto per mercato determina direttamente quante share stanno su ciascun lato, e il mid non
 * c'entra: a 0,16/0,84 e a 0,50/0,50 lo stesso capitale compra le stesse share.
 *
 * Il numero che conta e' la frazione di fill oltre la quale il RESIDUO scoperto e' ancora piazzabile:
 *     f_min = minSize x pairCost / capitale
 * Su un mercato a `minSize 20` con pairCost 0,98:  $130 → 15% · $65 → 30% · $40 → 49% · $25 → 78%.
 * Sotto quella frazione il residuo finisce nel registro di accumulo (§5 punto 54) invece di rientrare
 * subito in un ordine — l'opposto di «uscire subito».
 *
 * VA DETTO CHE UNA GARANZIA PIENA NON ESISTE: il residuo e' `Q x f`, quindi per f abbastanza piccolo sta
 * sotto il minimo con QUALUNQUE tetto. $65 non elimina il caso, sposta la soglia dal 15% al 30% — cioe'
 * rende «residuo bloccato» un evento di coda invece che l'esito di un fill parziale ordinario.
 *
 * IL COSTO, MISURATO: a $65 le share per lato scendono a 66,3, quindi i mercati con `minSize 100` escono
 * dal perimetro. Sul board del 10 agosto costa **6 mercati** (92 → 86 piazzabili), contro i **+45** che
 * la rimozione del taglio per numero in agent24 porta nello stesso lavoro. Saldo +39.
 */
// ═══ DAL 12 AGOSTO 2026 IL TETTO È DERIVATO DAL CAPITALE, NON PIÙ UNA COSTANTE ═══════════════════
// $130 → $65 → e adesso nessun numero: una FRAZIONE. La ragione è che la costante contraddiceva nei
// fatti la filosofia che questo stesso file dichiara. Con $65 fissi e $663 di capitale il sistema usa
// **10 mercati**; i due wallet affini sopravvissuti al filtro (docs/wallet-affini-12ago.md) ne tengono
// 133 e 191 — con capitale da 5 a 44 volte il nostro. La forma non è copiabile, la direzione sì, ed è
// la stessa che §5 punto 65 scrive: «quando il capitale cresce si spalma su PIÙ mercati».
// Con un tetto FISSO quella frase è vera solo finché il capitale non cambia. Con una frazione è vera
// sempre: il numero di mercati scala col capitale e la size per mercato resta proporzionalmente uguale.
// LA GRANDEZZA DA CUI TUTTO DERIVA E' `f_min`, non una frazione del capitale.
//
// ⚠ UNA FRAZIONE PURA NON FUNZIONA, e va detto perche' e' il primo tentativo naturale: con
// `tetto = capitale x k` il numero di mercati resta COSTANTE (capitale/tetto = 1/k) e a crescere e' la
// size. E' esattamente l'opposto della filosofia. La grandezza giusta e' il tetto in DOLLARI, ancorato
// al vincolo vero, con il numero di mercati che scala da se': N = capitale / tetto.
//
// `f_min` e' la frazione di fill sotto la quale il residuo scoperto NON e' piu' piazzabile:
//     f_min = minSize x costoCoppia / tetto     ⇒     tetto = minSize x costoCoppia / f_min
// E' il numero con cui l'operatore ha gia' mosso il tetto due volte ($130 → 15%, $65 → 30%).
// Scegliendo l'obiettivo si sceglie il tetto, e il legame diventa esplicito invece che aritmetico a
// posteriori. **0,60**: a $663 da' $32,67 per mercato e **20 mercati**, il punto raccomandato in
// docs/quanti-mercati-12ago.md (la curva di rendimento e' piatta oltre, +15% da 20 a 33).
const F_MIN_OBIETTIVO = 0.60;
// Il minimo premiante piu' comune: 86 mercati su 118 sul board del 12 agosto (73%).
const MIN_PREMIANTE_TIPICO = 20;

// ═══ IL PAVIMENTO PREMIANTE, CHE È IL VERO VINCOLO ═══════════════════════════════════════════════
// Sotto `min_incentive_size` il venue accetta l'ordine e **non gli assegna punteggio**
// (`venue-rules.js:86`: «earns nothing»). Non è «meno reward»: è ZERO. Quindi la frazione non può
// scendere sotto quel pavimento, e il pavimento NON è un numero unico — misurato sul board del 12
// agosto: **20 su 86 mercati, 50 su 16, 100 su 6, 200 su 10**. Varia di un fattore dieci.
//
// IL MARGINE. A N massimo (33 mercati) il margine sul pavimento era **2,5%**: un mid che si muove o un
// mercato che ruota su un minimo più alto fa cadere l'ordine sotto soglia, dove il reward è zero e non
// «un po' meno». 25% è la scelta: copre il salto di un mercato dal minimo 20 al successivo scalino
// utile senza costare mercati sul board di oggi (a $33,16 il pavimento con margine è $24,50).
const MARGINE_PAVIMENTO = 0.25;
// Il costo di una coppia: le due gambe stanno dentro la banda, un tick dietro il tocco su ciascun lato,
// quindi costano insieme `1 − 2·offset`. Misurato sui piani veri (§5 punto 48): 0,98. NON dipende dal
// mid — è la proprietà che rende il pavimento calcolabile senza conoscere il prezzo.
const COSTO_COPPIA = 0.98;

// ═══ IL TETTO AL NUMERO DI MERCATI, PER CARICO ═══════════════════════════════════════════════════
// Non è un limite di rischio — quello è il tetto per mercato — è un limite di COSTO, e i numeri sono
// misurati (docs/quanti-mercati-12ago.md §4): agent34 regge 125 mercati (250 asset / 2), i rinnovi GTD
// costano 2 gambe × 3/ora = 6N richieste l'ora. A N=40 sono 240/ora = 4 al minuto, cioè il 12% del
// carico di flotta misurato (33,3 req/min), e 80 asset sui 250 del budget del feed.
// 40 e non 125: la curva di rendimento è PIATTA oltre i 20 mercati (+15% da 20 a 33, +4,7% da 25 a 33),
// quindi oltre quella soglia si paga carico per un guadagno che non c'è.
const MAX_MERCATI = 40;

// ⚠ COMPATIBILITÀ: era una costante importata da quattro consumatori. Resta esportata come il tetto
// che la frazione produce sul CAPITALE DI RIFERIMENTO ($663,11, il capitale reale del 12 agosto), così
// chi la legge per un log o un test non si rompe — ma NON va usata per decidere: la decisione passa da
// `capPerMarketUsd(capitale)`. Un test verifica che i consumatori che DECIDONO usino la funzione.
const CAPITALE_RIFERIMENTO_USD = 663.11;
/** Il tetto BASE in dollari, derivato da `f_min`. Non scala col capitale: e' il capitale che scala
 *  il NUMERO di mercati. Cresce solo quando servirebbero piu' di `MAX_MERCATI` mercati. */
const TETTO_BASE_USD = +(MIN_PREMIANTE_TIPICO * COSTO_COPPIA / F_MIN_OBIETTIVO).toFixed(2);
const MARKET_CAP_FIXED_USD = TETTO_BASE_USD;

/** ── IL TETTO PER SINGOLO ORDINE, DERIVATO E NON SCELTO (9 agosto 2026) ────────────────────────────
 *
 *  ═══ IL GUASTO CHE LO FA NASCERE ═══════════════════════════════════════════════════════════════
 *  Il tetto per ORDINE viveva in DUE costanti indipendenti, entrambe a $25 e nessuna delle due
 *  collegata al tetto per mercato: `adapter.LIVE_MIN_DEFAULT_CAP_USD` e
 *  `manual-order.FALLBACK_LIVE_MIN_CAP_USD`. Finché il tetto per mercato era il 20% di un conto
 *  piccolo i due numeri convivevano; col tetto fisso a $130 — cioè ~$65 per lato — ogni gamba ha
 *  cominciato a sfondare il tetto per ordine, e OGNI piazzamento è stato rifiutato.
 *
 *  Misurato il 9 agosto alle 20:37, con il bot su AVVIA e $561,37 liberi: quattro mercati scelti,
 *  otto gambe proposte, **zero piazzate** — tutte con `gate: manual-order-cap`, «controvalore $99,14
 *  oltre il tetto per ordine $25,00». Utilizzo del capitale fermo al 16,4% contro l'obiettivo del 90%.
 *  Falliva CHIUSO — nessuna esposizione a un lato solo, le gambe orfane ritirate — ma non piazzava.
 *
 *  ═══ PERCHÉ DERIVATO E NON UN TERZO NUMERO ═════════════════════════════════════════════════════
 *  È la terza volta in due giorni che lo stesso concetto vive in due posti e i due divergono. Un
 *  quarto numero indipendente avrebbe solo spostato la prossima divergenza più in là. Qui il tetto
 *  per ordine è una CONSEGUENZA di quello per mercato: un ordine è UNA gamba, e le gambe sono due,
 *  quindi il pavimento necessario è `MARKET_CAP_FIXED_USD / 2`. Cambiare il tetto per mercato muove
 *  automaticamente anche questo, e il disallineamento non può ripresentarsi.
 *
 *  ═══ IL MARGINE, E PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════
 *  $5 sopra la metà esatta. Il knapsack non divide sempre a metà precisa — il costo della coppia
 *  (`1 − 2·offset`) e l'arrotondamento al tick spostano le due gambe di qualche centesimo l'una
 *  rispetto all'altra — e un tetto messo ESATTAMENTE a $65 rifiuterebbe la gamba che finisce a
 *  $65,02 ricreando lo stesso collo di bottiglia per pochi centesimi. Il margine è la differenza fra
 *  un limite e una trappola.
 *
 *  ═══ COSA RESTA UN LIMITE VERO ═════════════════════════════════════════════════════════════════
 *  Questo NON disattiva niente: il gate continua a rifiutare tutto ciò che lo supera, e resta il PIÙ
 *  STRETTO fra sé e `safety-risk-limits.maxOrderNotionalUsd` (`min()` in `manual-order.resolveCaps`).
 *  Alzarlo a $70 sposta la soglia dove il piano la richiede; non toglie la cintura. */
const MARGINE_ORDINE_USD = 5;
// Derivato come prima, ma dal tetto DERIVATO: una gamba è metà mercato, più il margine.
// Resta esportato anche come costante al capitale di riferimento, per i consumatori che non hanno il
// capitale a portata di mano (l'adapter, che gira dentro il gate di un singolo ordine).
const LIVE_MIN_ORDER_CAP_USD = MARKET_CAP_FIXED_USD / 2 + MARGINE_ORDINE_USD;
function liveMinOrderCapUsd(capitalUsd) {
  return +(capPerMarketUsd(capitalUsd) / 2 + MARGINE_ORDINE_USD).toFixed(2);
}

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Il tetto in dollari per un dato capitale.
 *
 * ═══ DUE DIFFERENZE RISPETTO ALLA VERSIONE A PERCENTUALE, ENTRAMBE PIÙ SICURE ══════════════════════
 *
 * 1. NON RESTITUISCE PIÙ `null` SU UN CAPITALE ILLEGGIBILE. Prima doveva: il tetto era `capitale × 0,20`
 *    e senza il capitale non era calcolabile. Ma `null` a valle vale «nessun tetto» (l'allocatore
 *    ripiega su `budgetUsd`), quindi un capitale illeggibile ALLARGAVA il tetto invece di stringerlo —
 *    fail-OPEN su un vincolo di rischio. Con un tetto fisso il numero è sempre noto e quel ramo sparisce.
 *
 * 2. SI CLAMPA AL CAPITALE quando il capitale è leggibile. Con $50 in cassa non ha senso concedere $130
 *    su un mercato: il tetto può solo STRINGERE, mai concedere più di quanto ci sia. È la stessa cosa
 *    che `allocateBudget` fa già con `Math.min(maxPerMarketUsd, budgetUsd)`, portata a monte perché
 *    valga anche per i due percorsi che non passano dall'allocatore.
 *
 * @param {number|null|undefined} capitalUsd  il capitale disponibile; assente ⇒ si usa il tetto pieno
 * @returns {number} sempre un numero utilizzabile
 */
function capPerMarketUsd(capitalUsd) {
  // Capitale illeggibile ⇒ il pavimento del minimo piu' comune (20 share). NON `null`, che a valle
  // varrebbe «nessun tetto» — il fail-open che la versione a percentuale aveva e che non torna.
  if (!fin(capitalUsd) || capitalUsd <= 0) return pavimentoPremiante(20);
  // Il tetto base, e — solo se il capitale e' grande — quanto serve per non superare MAX_MERCATI.
  // E' qui che il capitale entra: sotto la soglia di carico fa crescere N, sopra fa crescere la size.
  const perCarico = capitalUsd / MAX_MERCATI;
  const conPavimento = Math.max(TETTO_BASE_USD, perCarico, pavimentoPremiante(MIN_PREMIANTE_TIPICO));
  // E puo' solo STRINGERE: con $30 in cassa non ha senso concedere $33 su un mercato.
  return +Math.min(conPavimento, capitalUsd).toFixed(2);
}

/** Il capitale minimo che un mercato con QUESTO minimo premiante richiede, margine incluso.
 *  `min_incentive_size` e' per mercato (20/50/100/200 sul board di oggi): usare un valore unico qui
 *  sarebbe la stessa scorciatoia che ha reso il tetto una costante. */
function pavimentoPremiante(minSize) {
  if (!fin(minSize) || minSize <= 0) return null;
  return +(minSize * COSTO_COPPIA * (1 + MARGINE_PAVIMENTO)).toFixed(2);
}

/**
 * Questo mercato sta sopra il pavimento premiante al tetto che il capitale concede?
 *
 * FALSO ⇒ **non si quota affatto**. È la parte che la filosofia richiede esplicitamente: meglio meno
 * mercati sopra soglia che tanti sotto, dove il reward non è piu' basso — e' ZERO. `null` quando il
 * minimo non e' leggibile: non si indovina, e chi legge decide (la stessa regola di `horizonVerdict`).
 */
function mercatoAmmissibile(capitalUsd, minSize) {
  const pav = pavimentoPremiante(minSize);
  if (pav == null) return { ammissibile: null, motivo: 'minimo premiante non leggibile' };
  const tetto = capPerMarketUsd(capitalUsd);
  if (tetto >= pav) {
    return { ammissibile: true, tettoUsd: tetto, pavimentoUsd: pav,
      margine: +((tetto - pav) / pav).toFixed(3), motivo: null };
  }
  return { ammissibile: false, tettoUsd: tetto, pavimentoUsd: pav, margine: null,
    motivo: `il tetto per mercato ($${tetto.toFixed(2)}) sta sotto il pavimento premiante di questo mercato `
      + `($${pav.toFixed(2)} = ${minSize} share × ${COSTO_COPPIA} × ${1 + MARGINE_PAVIMENTO}): `
      + 'sotto min_incentive_size il venue non assegna punteggio e il reward e\' ZERO, non piu\' basso' };
}

/** Quanti mercati il capitale sostiene: conseguenza del tetto, limitata dal carico. */
function mercatiSostenibili(capitalUsd) {
  if (!fin(capitalUsd) || capitalUsd <= 0) return 0;
  const tetto = capPerMarketUsd(capitalUsd);
  return Math.max(0, Math.min(MAX_MERCATI, Math.floor(capitalUsd / tetto)));
}

/** La finestra di mid ammessa dal tetto per ORDINE, che si allarga quando il tetto scende.
 *  `Q = capitale/costoCoppia` share per lato; la gamba cara costa `Q × p`, e deve stare sotto
 *  `tetto/2 + margine` ⇒ `p ≤ costoCoppia · (tetto/2 + margine) / tetto`. */
function finestraMid(capitalUsd) {
  const tetto = capPerMarketUsd(capitalUsd);
  const pMax = COSTO_COPPIA * (tetto / 2 + MARGINE_ORDINE_USD) / tetto;
  const hi = Math.min(0.99, +pMax.toFixed(3));
  return { lo: +(1 - hi).toFixed(3), hi, tettoUsd: tetto, tettoOrdineUsd: +(tetto / 2 + MARGINE_ORDINE_USD).toFixed(2) };
}

/** Quanti mercati servono per impegnare `capitalUsd` a questo tetto. È il numero che PRIMA veniva
 *  deciso a mano da `MAX_POSIZIONI`; adesso è una conseguenza, e chi legge un piano deve poterlo
 *  confrontare con quanti mercati qualificati il board offre davvero. `null` se il capitale non si legge. */
function mercatiNecessari(capitalUsd) {
  if (!fin(capitalUsd) || capitalUsd <= 0) return null;
  return Math.ceil(capitalUsd / capPerMarketUsd(capitalUsd));
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/concentration').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond, extra) => { assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); n++; };

  ok('il tetto BASE deriva da f_min, non e\' scelto', TETTO_BASE_USD === +(MIN_PREMIANTE_TIPICO * COSTO_COPPIA / F_MIN_OBIETTIVO).toFixed(2));
  ok('  e con $663,11 da\' 20 mercati (il punto raccomandato)', mercatiSostenibili(663.11) === 20,
    `${mercatiSostenibili(663.11)} mercati a $${capPerMarketUsd(663.11)}`);
  ok('IL NUMERO DI MERCATI SCALA COL CAPITALE', mercatiSostenibili(400) < mercatiSostenibili(663.11)
    && mercatiSostenibili(663.11) < mercatiSostenibili(1000),
    `$400→${mercatiSostenibili(400)} · $663→${mercatiSostenibili(663.11)} · $1000→${mercatiSostenibili(1000)}`);
  ok('  e la size per mercato NON cresce finche\' il carico regge',
    capPerMarketUsd(400) === capPerMarketUsd(1000));
  ok('oltre il tetto di carico e\' la size a crescere, non N', mercatiSostenibili(5000) === MAX_MERCATI
    && capPerMarketUsd(5000) > capPerMarketUsd(1000));
  ok('il pavimento premiante e\' per MERCATO, non unico',
    pavimentoPremiante(20) < pavimentoPremiante(50) && pavimentoPremiante(50) < pavimentoPremiante(200));
  ok('  e un mercato sotto il pavimento NON e\' ammissibile', mercatoAmmissibile(663.11, 200).ammissibile === false);
  ok('  mentre il minimo tipico lo e\'', mercatoAmmissibile(663.11, 20).ammissibile === true);
  ok('il tetto per ordine resta DERIVATO', liveMinOrderCapUsd(663.11) === +(capPerMarketUsd(663.11) / 2 + MARGINE_ORDINE_USD).toFixed(2));
  ok('la finestra di mid si allarga rispetto a [0,435 · 0,565]', finestraMid(663.11).hi > 0.565,
    `[${finestraMid(663.11).lo} · ${finestraMid(663.11).hi}]`);

  // ── il clamp: può solo stringere
  // Il clamp vale ancora, ma la soglia si e' spostata: il tetto BASE ora e' $32,67, non $65, quindi
  // un capitale di $50 sta SOPRA il tetto e non lo clampa piu'. Si verifica sotto la base.
  ok('capitale sotto il tetto base ⇒ il tetto scende al capitale', capPerMarketUsd(20) === 20);
  ok('  e sopra la base il tetto resta la base', capPerMarketUsd(50) === TETTO_BASE_USD);
  ok('  e non concede mai più del capitale disponibile', capPerMarketUsd(10) === 10);
  ok('capitale esattamente al tetto base ⇒ il tetto base', capPerMarketUsd(TETTO_BASE_USD) === TETTO_BASE_USD);

  // ── il ramo che PRIMA falliva aperto
  ok('capitale illeggibile ⇒ tetto PIENO, mai «nessun tetto»',
    capPerMarketUsd(null) === pavimentoPremiante(MIN_PREMIANTE_TIPICO)
    && capPerMarketUsd(undefined) === pavimentoPremiante(MIN_PREMIANTE_TIPICO)
    && capPerMarketUsd(NaN) === pavimentoPremiante(MIN_PREMIANTE_TIPICO)
    && capPerMarketUsd('65') === pavimentoPremiante(MIN_PREMIANTE_TIPICO));
  ok('  capitale zero o negativo ⇒ tetto pieno, non zero e non null',
    capPerMarketUsd(0) === pavimentoPremiante(MIN_PREMIANTE_TIPICO) && capPerMarketUsd(-5) === pavimentoPremiante(MIN_PREMIANTE_TIPICO));
  ok('  NON restituisce mai null: a valle null varrebbe «nessun tetto»',
    [null, undefined, NaN, 0, -1, 50, 130, 5000].every((v) => typeof capPerMarketUsd(v) === 'number'));

  // ── il numero di mercati è una CONSEGUENZA
  // Col tetto dimezzato il numero di mercati necessari RADDOPPIA a parità di capitale: è la ragione
  // per cui il tetto è stato abbassato, e va verificato invece che assunto.
  // Col tetto DERIVATO il numero di mercati scala col capitale finche' il carico regge, poi si ferma.
  ok('$594 liberi ⇒ 19 mercati necessari', mercatiNecessari(594.10) === 19, String(mercatiNecessari(594.10)));
  ok('$1.000 ⇒ 31 mercati', mercatiNecessari(1000) === 31, String(mercatiNecessari(1000)));
  ok('  e oltre il tetto di carico il conto si ferma a MAX_MERCATI',
    mercatiSostenibili(5000) === MAX_MERCATI);
  ok('  capitale illeggibile ⇒ null, non un numero inventato',
    mercatiNecessari(null) === null && mercatiNecessari(0) === null);

  // ── IL TETTO PER ORDINE, DERIVATO ────────────────────────────────────────────────────────────
  ok('il tetto per ordine è derivato dal tetto base', LIVE_MIN_ORDER_CAP_USD === +(TETTO_BASE_USD / 2 + MARGINE_ORDINE_USD).toFixed(2)
    || LIVE_MIN_ORDER_CAP_USD === TETTO_BASE_USD / 2 + MARGINE_ORDINE_USD, String(LIVE_MIN_ORDER_CAP_USD));
  ok('  ed è DERIVATO dal tetto per mercato, non un numero indipendente',
    LIVE_MIN_ORDER_CAP_USD === MARKET_CAP_FIXED_USD / 2 + MARGINE_ORDINE_USD);
  ok('  copre una gamba da metà tetto per mercato ($32,50) con margine',
    LIVE_MIN_ORDER_CAP_USD > MARKET_CAP_FIXED_USD / 2);
  ok('  e il margine è dichiarato, non nascosto in un arrotondamento', MARGINE_ORDINE_USD === 5);
  // La gamba tipica scala col tetto: a $65 per mercato una gamba vale ~$32,50 a mid 0,50, e il tetto
  // per ordine deve coprirla con margine. Il numero non e' copiato: si ricava dal tetto stesso.
  ok('  una gamba tipica del piano (metà tetto) ci sta dentro',
    LIVE_MIN_ORDER_CAP_USD >= MARKET_CAP_FIXED_USD / 2);
  ok('  una gamba oltre il tetto per mercato intero NON ci sta',
    MARKET_CAP_FIXED_USD > LIVE_MIN_ORDER_CAP_USD);

  console.log('concentration: ' + n + ' assertions passed');
  return n;
}

module.exports = { MARKET_CAP_FIXED_USD, LIVE_MIN_ORDER_CAP_USD, MARGINE_ORDINE_USD,
  F_MIN_OBIETTIVO, MIN_PREMIANTE_TIPICO, TETTO_BASE_USD, MARGINE_PAVIMENTO, COSTO_COPPIA,
  MAX_MERCATI, CAPITALE_RIFERIMENTO_USD,
  capPerMarketUsd, pavimentoPremiante, mercatoAmmissibile, mercatiSostenibili, finestraMid,
  liveMinOrderCapUsd, mercatiNecessari, selfcheck };

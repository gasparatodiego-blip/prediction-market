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
const MARKET_CAP_FIXED_USD = 65;

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
const LIVE_MIN_ORDER_CAP_USD = MARKET_CAP_FIXED_USD / 2 + MARGINE_ORDINE_USD;

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
  if (!fin(capitalUsd) || capitalUsd <= 0) return MARKET_CAP_FIXED_USD;
  return +Math.min(MARKET_CAP_FIXED_USD, capitalUsd).toFixed(2);
}

/** Quanti mercati servono per impegnare `capitalUsd` a questo tetto. È il numero che PRIMA veniva
 *  deciso a mano da `MAX_POSIZIONI`; adesso è una conseguenza, e chi legge un piano deve poterlo
 *  confrontare con quanti mercati qualificati il board offre davvero. `null` se il capitale non si legge. */
function mercatiNecessari(capitalUsd) {
  if (!fin(capitalUsd) || capitalUsd <= 0) return null;
  return Math.ceil(capitalUsd / MARKET_CAP_FIXED_USD);
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/concentration').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond, extra) => { assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); n++; };

  ok('il tetto è FISSO e vale $65', MARKET_CAP_FIXED_USD === 65);
  ok('non dipende dal capitale: $670 e $2.000 danno lo stesso tetto',
    capPerMarketUsd(670) === 65 && capPerMarketUsd(2000) === 65);
  ok('  ed è esattamente il valore dichiarato, non un arrotondamento', capPerMarketUsd(1e9) === MARKET_CAP_FIXED_USD);

  // ── il clamp: può solo stringere
  ok('capitale sotto il tetto ⇒ il tetto scende al capitale', capPerMarketUsd(50) === 50);
  ok('  e non concede mai più del capitale disponibile', capPerMarketUsd(64.5) === 64.5);
  ok('capitale esattamente al tetto ⇒ il tetto', capPerMarketUsd(65) === 65);

  // ── il ramo che PRIMA falliva aperto
  ok('capitale illeggibile ⇒ tetto PIENO, mai «nessun tetto»',
    capPerMarketUsd(null) === 65 && capPerMarketUsd(undefined) === 65
    && capPerMarketUsd(NaN) === 65 && capPerMarketUsd('65') === 65);
  ok('  capitale zero o negativo ⇒ tetto pieno, non zero e non null',
    capPerMarketUsd(0) === 65 && capPerMarketUsd(-5) === 65);
  ok('  NON restituisce mai null: a valle null varrebbe «nessun tetto»',
    [null, undefined, NaN, 0, -1, 50, 130, 5000].every((v) => typeof capPerMarketUsd(v) === 'number'));

  // ── il numero di mercati è una CONSEGUENZA
  // Col tetto dimezzato il numero di mercati necessari RADDOPPIA a parità di capitale: è la ragione
  // per cui il tetto è stato abbassato, e va verificato invece che assunto.
  ok('$594 liberi ⇒ 10 mercati necessari (erano 5 a $130)', mercatiNecessari(594.10) === 10);
  ok('$1.000 ⇒ 16 mercati', mercatiNecessari(1000) === 16);
  ok('$2.000 ⇒ 31 mercati', mercatiNecessari(2000) === 31);
  ok('  capitale illeggibile ⇒ null, non un numero inventato',
    mercatiNecessari(null) === null && mercatiNecessari(0) === null);

  // ── IL TETTO PER ORDINE, DERIVATO ────────────────────────────────────────────────────────────
  ok('il tetto per ordine è $37,50', LIVE_MIN_ORDER_CAP_USD === 37.5);
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
  capPerMarketUsd, mercatiNecessari, selfcheck };

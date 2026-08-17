'use strict';

/**
 * LA PRESA DI PROFITTO — quando conviene incassare invece di completare la coppia.
 *
 * ═══ IL FATTO CHE LA RENDE NECESSARIA, E LA MISURA CHE NE HA CAMBIATO IL DISEGNO ════════════════
 * L'operatore ha visto un guadagno sul pannello il 16 agosto 2026 e non è stato incassato. La misura
 * (`scripts/ricerca/take-profit-16-agosto.js`, output in `data/ricerca/take-profit-2026-08-16.json`)
 * dice che quel guadagno **non era incassabile**, ed è il risultato che ha deciso questo modulo:
 *
 *   FL-27 · NO 56,82 share a 20¢ (costo $11,36) · finestra 15:20 → 18:32, 153 campioni di libro
 *     il pannello al massimo:  $13,35  ⇒ guadagno APPARENTE +$1,99
 *     il TETTO realizzabile:   $11,36  ⇒ margine **+$0,00** (tutta la size al miglior prezzo)
 *     istanti in guadagno: **0** · in pareggio: 1 · in perdita: 152
 *   FL-02 · YES 57,1 share a 54¢ (costo $30,83) · 130 campioni
 *     il TETTO realizzabile:   $30,26  ⇒ margine **−$0,57**
 *     istanti in guadagno: **0** su 130
 *
 * Cioè: **su 283 campioni, zero offrivano un'uscita in guadagno**, e il conto è fatto con l'ipotesi
 * più generosa possibile (tutta la size al miglior prezzo, senza camminare la scala). Il +$1,99 era
 * la differenza fra il **mid** e il **bid**, non un guadagno.
 *
 * ⚠ DA QUI LA REGOLA CENTRALE DI QUESTO MODULO: **si decide sul prezzo REALIZZABILE, mai sul mid.**
 * Il take-profit che esisteva già — il ramo `mercato-a-favore` di `exit-plan.planExit`, con il suo
 * cricchetto — è ancorato a `scoringMid` e piazza l'uscita a `mid × 1,01`, cioè **sopra** un mid che
 * la misura dichiara già non consumabile. Non è una regola sbagliata nell'intenzione: è ancorata al
 * numero sbagliato, e per questo non ha mai incassato niente. Questo modulo non lo sostituisce e non
 * lo tocca — gli mette accanto la domanda che nessuno faceva: *qualcuno ci sta davvero comprando la
 * posizione, adesso, a un prezzo che batte l'alternativa?*
 *
 * ═══ LE DUE STRADE SI ESCLUDONO, E IL CRITERIO NON HA BISOGNO DI UNA COSTANTE ARBITRARIA ════════
 * Dopo un fill le vie sono due e non si possono percorrere entrambe:
 *
 *   A · INCASSARE   — si vende la gamba posseduta al bid. Ricavo per share = `b` (bid camminato).
 *   B · COMPLETARE  — si compra l'altra gamba all'ask e si fonde la coppia, che rende **$1,00/share**.
 *                     Ricavo per share = `1 − a` (ask camminato sull'altro lato).
 *
 * A batte B esattamente quando `b > 1 − a`, cioè quando **`b + a > 1`**. Non serve nessuna soglia
 * inventata: le due strade si confrontano con due prezzi letti dallo stesso libro nello stesso
 * istante. È il criterio che l'operatore ha chiesto, ed è aritmetica, non taratura.
 *
 * ═══ COSA SI PERDE — i due termini, e quale dei due è misurato ══════════════════════════════════
 * ① **IL MARGINE DELLA COPPIA**: `1 − c − a` per share, dove `c` è il carico. È **misurato**
 *    all'istante della decisione, ed è per costruzione più piccolo di quello che si incassa — perché
 *    è esattamente la differenza che il criterio pretende. Quindi la perdita è nota e limitata: vale
 *    almeno `MARGINE_CENTS` per share in meno di ciò che si prende.
 * ② **I PREMI SULLE DUE GAMBE**: chiudere la posizione cancella gli ordini a riposo, che smettono di
 *    maturare. Questo termine **NON è misurato e oggi non è misurabile**: il consuntivo reward vero è
 *    `$0,00` e il venue non ha ancora pagato (`data/confronto-reward.json`, «la finestra di pagamento
 *    di 2026-08-15 non è ancora chiusa»). L'unico numero disponibile è **modellato dal board**:
 *      · FL-27 — `rewardsDailyRate` $100/g, quota modellata 0,124 a $500 ⇒ a ~$56 di capitale circa
 *        **$1,45/g**, cioè ~$0,06/h ⇒ su 57 share ≈ **0,05¢/share** nella mezz'ora tipica;
 *      · FL-02 — `rewardsDailyRate` $127/g, libro sottile, quota 0,545 a $500 ⇒ a ~$56 circa
 *        **$13,9/g**, cioè ~$0,58/h ⇒ ≈ **0,5¢/share** nella mezz'ora tipica.
 *    La mezz'ora è la mediana misurata con cui un fill si chiude completando la coppia (§5-bis p.162:
 *    32,1% dei fill, 28,6 min mediani).
 *
 * ═══ DA LÌ IL MARGINE, CHE È L'UNICA COSTANTE E NON È SCELTA A OCCHIO ═══════════════════════════
 * `MARGINE_CENTS = 1` centesimo **per share**. Due ragioni che coincidono:
 *   · copre il termine ② nel caso peggiore misurato (0,5¢/share sul mercato più ricco dei due), con
 *     il doppio di margine;
 *   · è **un tick sulla griglia modale** (1,0¢): sotto un tick le due strade sono indistinguibili dal
 *     rumore di quantizzazione del libro, e quando la differenza è rumore la risposta prudente è
 *     **non cambiare strada** — cioè continuare a completare la coppia, che è ciò che il bot già fa.
 * ⚠ NON è espresso in tick, ed è la lezione di §5-bis p.164: un margine in tick è adattivo alla
 * GRIGLIA e non al mercato, e su un libro a tick 0,1¢ varrebbe un decimo di quello che serve.
 *
 * ═══ SI ATTRAVERSA, NON SI INSEGUE ══════════════════════════════════════════════════════════════
 * Quando scatta, si vende **al bid**, cioè attraversando lo spread. È deliberato e discende dalla
 * stessa misura: il guadagno esiste **solo** al bid, e mettersi da maker sopra il bid — cioè sul mid
 * o sull'ask — è esattamente ciò che `planExit` già fa e che in 283 campioni non ha incassato niente.
 * Un take-profit che non attraversa ricrea il difetto che deve chiudere.
 * Il prezzo proposto è il **bid camminato per la nostra size**, non il best bid: vendere 57 share
 * contro un best bid da 5 significa prendere anche i livelli sotto, e prezzare sul solo primo livello
 * dichiarerebbe un ricavo che non esiste.
 *
 * ═══ TUTTA LA SIZE O NIENTE ═════════════════════════════════════════════════════════════════════
 * Se la scala non copre l'intera posizione **non si vende una parte**. Un residuo sotto il minimo del
 * venue è capitale **senza via d'uscita fino alla risoluzione** — è il buco strutturale aperto di
 * §5.2 p.1, $26,30 già bloccati in cinque residui. Una regola nuova che ne produce altri non è un
 * miglioramento, e la vendita parziale è precisamente il modo di produrli.
 *
 * ═══ NON PUÒ INCROCIARSI CON LA SCALA DI URGENZA, E NON PER UN `if` ═════════════════════════════
 * `urgenza-scoperto` concede di scendere **fino al carico e sotto** (`profitPct: 0`, poi una
 * concessione in tick): opera dove il ricavo è **≤ carico**. Questo modulo pretende un ricavo
 * **> carico + margine**. I due domini sono disgiunti per costruzione, quindi nessuna combinazione di
 * gradino e presa di profitto può allentare un limite di rischio. È verificato da un test, non promesso.
 *
 * ═══ FAIL-CLOSED, IN UNA DIREZIONE SOLA ═════════════════════════════════════════════════════════
 * Qualunque dato mancante o illeggibile ⇒ **non scatta** e dichiara perché. Il difetto di questo
 * modulo è NON agire: la strada che resta è quella che il bot già percorre. `Number(null) === 0` è
 * la classe di difetto più ricorrente di questo repo (sei occorrenze, §5-bis) e qui produrrebbe un
 * bid di zero letto come «si vende a zero», quindi ogni numero è validato con `Number.isFinite`
 * **e** con il suo segno prima di essere usato.
 *
 * @module presa-di-profitto
 */

// Il tetto della coppia vive in UN punto solo (`chiusura-rapida`, 101¢ dal 16 agosto 2026) e si
// IMPORTA: ricopiarlo sarebbe il reperto D1 dell'audit, e qui deciderebbe se una strada è percorribile.
const { TETTO_COPPIA_CENTS } = require('./chiusura-rapida');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Il margine che l'incasso deve battere, in CENTESIMI PER SHARE. Si cambia solo qui. */
const MARGINE_CENTS = 1;

/**
 * Cammina una scala di livelli per `size`, restituendo il prezzo MEDIO ottenuto.
 *
 * ⚠ NON ESTRAPOLA MAI oltre la profondità che la scala dichiara: se i livelli finiscono prima,
 * `completa` è `false` e il chiamante non vende. Inventare un livello in più significherebbe
 * promettere un prezzo che il libro non offre — ed è la stessa disciplina di `cammina` nello script
 * di misura, dove serviva a non gonfiare il referto.
 *
 * ⚠ NON SI FIDA DELL'ORDINE IN CUI LA SCALA ARRIVA: si ordina qui, e per questo `verso` è
 * obbligatorio. Un array di bid consegnato dal peggiore al migliore verrebbe camminato al contrario e
 * produrrebbe un prezzo PEGGIORE del vero su una vendita — cioè un guadagno sottostimato, che è il
 * verso innocuo — ma su un ask produrrebbe un costo sottostimato, cioè una coppia che sembra più
 * conveniente di quanto sia. Una delle due direzioni sbaglia verso il rischio, quindi non si assume
 * l'ordinamento di nessuna delle due.
 *
 * @param {Array<{price:number,size:number}>} livelli GIÀ ripuliti dai nostri ordini (il chiamante usa
 *        `top-of-book.othersLadder`, la stessa funzione di «mai primo sul libro»: qui non si
 *        costruisce un secondo meccanismo).
 * @param {number} size
 * @param {'bid'|'ask'} verso  'bid' ⇒ il migliore è il PIÙ ALTO (si vende); 'ask' ⇒ il PIÙ BASSO (si compra).
 */
function cammina(livelli, size, verso) {
  if (!Array.isArray(livelli) || !fin(size) || !(size > 0)
    || (verso !== 'bid' && verso !== 'ask')) {
    return { medio: null, coperta: 0, completa: false, livelliUsati: 0 };
  }
  const puliti = [];
  for (const l of livelli) {
    const p = Number(l && (l.price != null ? l.price : l.prezzo));
    const q = Number(l && (l.size != null ? l.size : l.quantita));
    if (!fin(p) || !fin(q) || !(p > 0) || !(q > 0)) continue;   // un livello illeggibile si salta, non vale zero
    puliti.push({ price: p, size: q });
  }
  puliti.sort((a, b) => (verso === 'bid' ? b.price - a.price : a.price - b.price));

  let resta = size, valore = 0, coperta = 0, usati = 0;
  for (const l of puliti) {
    const preso = Math.min(resta, l.size);
    valore += preso * l.price; coperta += preso; resta -= preso; usati++;
    if (resta <= 1e-9) break;
  }
  return {
    medio: coperta > 0 ? valore / coperta : null,
    coperta: +coperta.toFixed(6),
    completa: resta <= 1e-9 && coperta > 0,
    livelliUsati: usati,
  };
}

/**
 * CONVIENE INCASSARE ADESSO INVECE DI COMPLETARE LA COPPIA?
 *
 * @param {object}   a
 * @param {number}   a.carico            prezzo medio di carico della gamba posseduta, dal venue
 * @param {number}   a.size              share possedute
 * @param {Array}    a.bidsMioLato       scala dei BID del libro che possiedo, ripulita dai nostri
 * @param {Array}    a.asksAltroLato     scala degli ASK dell'altro libro, ripulita dai nostri
 * @param {number}  [a.margineCents]     margine richiesto in centesimi/share (difetto MARGINE_CENTS)
 * @param {number}  [a.tettoCoppiaCents] tetto della coppia (difetto: quello importato)
 * @returns {{scatta:boolean, prezzo:number|null, size:number|null, via:string|null, motivo:string,
 *            ricavoIncassoUsd:number|null, ricavoCoppiaUsd:number|null, guadagnoUsd:number|null,
 *            margineCents:number, misurabile:boolean}}
 */
function presaDiProfitto({
  carico, size, bidsMioLato, asksAltroLato,
  margineCents = MARGINE_CENTS, tettoCoppiaCents = TETTO_COPPIA_CENTS,
} = {}) {
  const no = (motivo, extra = {}) => ({
    scatta: false, prezzo: null, size: null, via: null, motivo,
    ricavoIncassoUsd: null, ricavoCoppiaUsd: null, guadagnoUsd: null,
    margineCents, misurabile: false, ...extra,
  });

  if (!fin(carico) || !(carico > 0)) return no('prezzo di carico non leggibile: non si decide di incassare su un guadagno non calcolabile');
  if (!fin(size) || !(size > 0)) return no('nessuna posizione da incassare');
  const margine = fin(margineCents) && margineCents >= 0 ? margineCents / 100 : MARGINE_CENTS / 100;

  // ── QUANTO INCASSO DAVVERO, camminando il libro per l'INTERA size ────────────────────────────
  const b = cammina(bidsMioLato, size, 'bid');
  if (b.medio == null) {
    return no('la scala dei bid sul lato posseduto non è leggibile: nessun prezzo di incasso è calcolabile');
  }
  if (!b.completa) {
    // ⚠ NON si vende la parte coperta: un residuo sotto il minimo del venue non ha via d'uscita
    // fino alla risoluzione (§5.2 p.1). Meglio nessuna presa di profitto che un residuo murato.
    return no(
      `il libro copre solo ${b.coperta} share delle ${size} possedute: non si vende una parte,`
      + ' perché il residuo resterebbe sotto il minimo del venue e senza via d\'uscita (§5.2 p.1)',
      { copertaParziale: b.coperta },
    );
  }
  const bid = b.medio;
  const ricavoIncassoUsd = size * bid;

  // ── QUANTO RENDEREBBE COMPLETARE LA COPPIA, sullo STESSO libro e nello STESSO istante ────────
  // Due letture dello stesso snapshot: confrontarne una di adesso con una di prima renderebbe il
  // criterio dipendente dal ritardo fra le due, non dal mercato.
  const a = cammina(asksAltroLato, size, 'ask');
  const coppiaLeggibile = a.medio != null && a.completa;
  const ask = coppiaLeggibile ? a.medio : null;
  const coppiaCents = coppiaLeggibile ? (carico + ask) * 100 : null;
  const tetto = fin(tettoCoppiaCents) && tettoCoppiaCents >= 100 && tettoCoppiaCents <= 200
    ? tettoCoppiaCents : TETTO_COPPIA_CENTS;
  // La coppia è una strada VERA solo se il suo costo sta sotto il tetto: sopra, il completamento
  // verrebbe rifiutato a valle, e confrontarsi con una strada chiusa vorrebbe dire non incassare mai.
  const coppiaPercorribile = coppiaLeggibile && coppiaCents <= tetto + 1e-9;
  const ricavoCoppiaUsd = coppiaLeggibile ? size * (1 - ask) : null;

  const base = {
    ricavoIncassoUsd: +ricavoIncassoUsd.toFixed(4),
    ricavoCoppiaUsd: ricavoCoppiaUsd == null ? null : +ricavoCoppiaUsd.toFixed(4),
    guadagnoUsd: +((bid - carico) * size).toFixed(4),
    margineCents, misurabile: true,
    bidCamminato: +bid.toFixed(6), askAltroLato: ask == null ? null : +ask.toFixed(6),
    coppiaCents: coppiaCents == null ? null : +coppiaCents.toFixed(3),
    tettoCoppiaCents: tetto,
  };
  const si = (via, motivo) => ({
    scatta: true, prezzo: +bid.toFixed(6), size: +size.toFixed(6), via, motivo, ...base,
  });
  const noMis = (motivo) => ({ ...no(motivo), ...base, scatta: false, prezzo: null, size: null, via: null });

  // ── RAMO 1 · LA COPPIA È PERCORRIBILE: si incassa solo se la BATTE ───────────────────────────
  if (coppiaPercorribile) {
    // `b > (1 − a) + margine`, cioè `b + a > 1 + margine`. Scritto come somma perché è la forma in
    // cui si legge: quanto mi pagano la gamba che ho, più quanto mi costa quella che manca.
    if (bid + ask > 1 + margine) {
      return si('coppia-battuta',
        `incassare rende ${(bid * 100).toFixed(2)}¢/share contro i ${((1 - ask) * 100).toFixed(2)}¢/share`
        + ` che renderebbe completare la coppia (altro lato all'ask ${(ask * 100).toFixed(2)}¢):`
        + ` la somma bid+ask è ${((bid + ask) * 100).toFixed(2)}¢, oltre i 100¢ del merge più il margine`
        + ` di ${margineCents}¢. Le due strade si escludono e questa rende di più, adesso.`);
    }
    return noMis(
      `completare la coppia rende di più o uguale: ${((1 - ask) * 100).toFixed(2)}¢/share contro i`
      + ` ${(bid * 100).toFixed(2)}¢/share dell'incasso (bid+ask = ${((bid + ask) * 100).toFixed(2)}¢,`
      + ` serve oltre ${(100 + margineCents).toFixed(2)}¢). Si continua sulla strada della coppia.`);
  }

  // ── RAMO 2 · LA COPPIA È CHIUSA DAL TETTO: l'alternativa è la scala, che scende ───────────────
  // Qui completare costerebbe più del tetto, quindi il completamento verrà rifiutato e la posizione
  // finisce nelle mani di `urgenza-scoperto`, che concede solo di PEGGIORARE il prezzo col passare
  // del tempo. Se in questo momento il libro paga più del carico, quello è il guadagno migliore che
  // la posizione vedrà — ed è il caso reale di FL-27, dove l'ask di YES era sopra il tetto di 81¢.
  if (coppiaLeggibile) {
    if (bid > carico + margine) {
      return si('coppia-bloccata',
        `la coppia costerebbe ${coppiaCents.toFixed(2)}¢, oltre il tetto di ${tetto}¢: completare non è`
        + ` una strada percorribile e resta solo la scala d'uscita, che può soltanto scendere.`
        + ` Il libro paga ora ${(bid * 100).toFixed(2)}¢/share contro un carico di ${(carico * 100).toFixed(2)}¢:`
        + ' si incassa finché il guadagno esiste.');
    }
    return noMis(
      `la coppia è oltre il tetto (${coppiaCents.toFixed(2)}¢ contro ${tetto}¢), ma il libro paga`
      + ` ${(bid * 100).toFixed(2)}¢/share contro un carico di ${(carico * 100).toFixed(2)}¢:`
      + ' non c\'è nessun guadagno da prendere. Decide la scala d\'uscita.');
  }

  // ── RAMO 3 · L'ALTRO LATO NON È LEGGIBILE ────────────────────────────────────────────────────
  // ⚠ Non si incassa "per prudenza": senza l'ask non si sa se la coppia renderebbe di più, e vendere
  // qui potrebbe buttare via la strada migliore. Non sapere non è una ragione per agire.
  return noMis(
    'la scala degli ask sull\'altro lato non è leggibile per l\'intera size: senza quel prezzo non si'
    + ' sa se completare la coppia renderebbe di più, e non si incassa al buio.');
}

/** Selfcheck del modulo — gira con `node lib/maker/presa-di-profitto.js`. */
function selfcheck() {
  let ok = 0, ko = 0;
  const t = (cond, msg) => { if (cond) ok++; else { ko++; console.error('  ✗', msg); } };

  // Ramo 1 — la coppia è battuta: bid 0,60 + ask 0,45 = 105¢ > 101¢
  const r1 = presaDiProfitto({
    carico: 0.50, size: 10,
    bidsMioLato: [{ price: 0.60, size: 20 }],
    asksAltroLato: [{ price: 0.45, size: 20 }],
  });
  t(r1.scatta === true && r1.via === 'coppia-battuta', 'ramo 1 deve scattare');
  t(r1.prezzo === 0.6 && r1.size === 10, 'ramo 1 deve proporre bid e size intera');

  // Ramo 1 — la coppia vince: bid 0,50 + ask 0,45 = 95¢ < 101¢
  const r2 = presaDiProfitto({
    carico: 0.50, size: 10,
    bidsMioLato: [{ price: 0.50, size: 20 }],
    asksAltroLato: [{ price: 0.45, size: 20 }],
  });
  t(r2.scatta === false, 'ramo 1 non deve scattare quando la coppia rende di più');

  // Ramo 2 — coppia oltre il tetto (0,50 + 0,60 = 110¢) e bid sopra il carico
  const r3 = presaDiProfitto({
    carico: 0.50, size: 10,
    bidsMioLato: [{ price: 0.55, size: 20 }],
    asksAltroLato: [{ price: 0.60, size: 20 }],
  });
  t(r3.scatta === true && r3.via === 'coppia-bloccata', 'ramo 2 deve scattare a coppia bloccata');

  // Ramo 2 — coppia bloccata ma nessun guadagno
  const r4 = presaDiProfitto({
    carico: 0.50, size: 10,
    bidsMioLato: [{ price: 0.48, size: 20 }],
    asksAltroLato: [{ price: 0.60, size: 20 }],
  });
  t(r4.scatta === false, 'ramo 2 non scatta senza guadagno');

  // Tutta la size o niente
  const r5 = presaDiProfitto({
    carico: 0.50, size: 100,
    bidsMioLato: [{ price: 0.60, size: 20 }],
    asksAltroLato: [{ price: 0.45, size: 200 }],
  });
  t(r5.scatta === false && r5.copertaParziale === 20, 'size non coperta ⇒ non si vende una parte');

  // Fail-closed
  t(presaDiProfitto({ carico: null, size: 10, bidsMioLato: [{ price: 0.6, size: 20 }], asksAltroLato: [] }).scatta === false, 'carico nullo ⇒ non scatta');
  t(presaDiProfitto({ carico: 0.5, size: 10, bidsMioLato: null, asksAltroLato: null }).scatta === false, 'scale nulle ⇒ non scatta');
  t(presaDiProfitto({ carico: 0.5, size: 10, bidsMioLato: [{ price: 0.6, size: 20 }], asksAltroLato: null }).scatta === false, 'ask illeggibile ⇒ non scatta');

  // Il bid camminato, non il best bid
  const r6 = presaDiProfitto({
    carico: 0.50, size: 20,
    bidsMioLato: [{ price: 0.70, size: 10 }, { price: 0.50, size: 10 }],
    asksAltroLato: [{ price: 0.45, size: 50 }],
  });
  t(Math.abs(r6.bidCamminato - 0.60) < 1e-9, 'il prezzo deve essere la media camminata (0,60), non 0,70');

  console.log(`presa-di-profitto selfcheck: ${ok} verdi, ${ko} rossi`);
  return ko === 0;
}

module.exports = { presaDiProfitto, cammina, selfcheck, MARGINE_CENTS };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

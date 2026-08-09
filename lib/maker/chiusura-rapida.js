'use strict';
// lib/maker/chiusura-rapida.js — CHIUDERE IL RISCHIO SUBITO DOPO UN FILL SU UN LATO SOLO.
//
// ═══ COSA DECIDE, E COSA LA DISTINGUE DAL MERGE ═════════════════════════════════════════════════════
// Quando una gamba viene riempita e l'altra no, restiamo esposti direzionalmente su un lato. La
// gerarchia del merge (`strategia-merge.js`) prova gia' a completare la coppia, ma con un tetto STRETTO:
// `100¢ − carico − margine`, cioe' la coppia non deve mai costare piu' di ~99¢. Quel tetto esiste per
// proteggere il PROFITTO: sotto $1 la coppia rende per costruzione.
//
// Questa regola risponde a una domanda diversa, e la risposta e' una decisione dell'operatore presa il
// 9 agosto 2026: quanto sono disposto a pagare per NON restare esposto? La risposta e' **110¢**, che e'
// sopra la pari — cioe' si accetta una perdita certa di al massimo 10¢ per coppia in cambio della
// chiusura immediata del rischio direzionale.
//
// VA DETTO CHIARO, PERCHE' NESSUN COMMENTO DEVE FARLO SEMBRARE GRATIS: sopra i 100¢ la coppia e' una
// PERDITA garantita. Una coppia comprata a 110¢ paga $1 alla risoluzione: −10¢ certi. Non e' un difetto
// di questa regola, e' il suo prezzo — si compra certezza con denaro. Chi cambia il tetto sta cambiando
// quanto e' disposto a pagare, non sta correggendo un errore.
//
// ═══ TAKER FINCHE' SI PUO', LIMIT PER IL RESTO ══════════════════════════════════════════════════════
// Il book non e' infinito al miglior prezzo. Si cammina la scala degli ask dell'altro lato prendendo i
// livelli finche' `carico + prezzo <= tetto`; quello che resta non si compra a qualunque prezzo — si
// posa un LIMIT esattamente al prezzo che terrebbe la coppia AL tetto, e si aspetta che il book scenda.
// Cosi' il tetto non e' un obiettivo medio ma un limite duro per ogni singolo share comprato.
//
// ═══ IL TETTO E' DURO, E LA DIREZIONE DELL'ARROTONDAMENTO LO DIMOSTRA ═══════════════════════════════
// Il prezzo limite si arrotonda GIU' al tick (`Math.floor`). Arrotondare su avrebbe fatto sforare il
// tetto di una frazione di tick su ogni mercato a tick grosso — un centesimo alla volta, invisibile nei
// test che guardano solo il caso medio. Un test dedicato prova il book sottile e verifica share per
// share che nessun prezzo proposto porti la coppia sopra il tetto.
//
// ═══ COSA NON FA ════════════════════════════════════════════════════════════════════════════════════
// Non piazza, non legge, non tocca il venue: e' pura, gli ingressi arrivano gia' letti. Non conosce
// `mai-primo-sul-libro`, la banda premiante o la soglia di perdita — quelle stanno a valle, sul percorso
// di piazzamento, e continuano ad applicarsi a questi ordini come a tutti gli altri.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * IL TETTO DELLA COPPIA, IN CENTESIMI. Decisione esplicita dell'operatore (9 agosto 2026).
 *
 * 110 e non 100: a 100¢ esatti la chiusura sarebbe possibile solo quando il mercato la regala, cioe'
 * quasi mai proprio quando serve — il momento in cui un lato si riempie e l'altro no e' per definizione
 * un momento in cui il book si e' mosso contro di noi. I 10¢ sopra la pari sono il margine che rende la
 * regola applicabile invece che teorica.
 *
 * Si cambia con `MAKER_TETTO_COPPIA_CENTS`; un valore illeggibile o fuori da [100, 200] viene SCARTATO
 * in favore del difetto — la stessa regola di fine scala e dell'orizzonte. Sotto 100 non si scende
 * nemmeno su richiesta: sarebbe il tetto del merge, che vive altrove e ha un'altra ragione.
 */
function leggiTetto(env = process.env) {
  const v = Number(env.MAKER_TETTO_COPPIA_CENTS);
  return fin(v) && v >= 100 && v <= 200 ? v : 110;
}
const TETTO_COPPIA_CENTS = leggiTetto();

/** Arrotonda GIU' al tick. Verso obbligato: verso l'alto si sforerebbe il tetto di una frazione di tick. */
function giuAlTick(prezzo, tick) {
  if (!fin(tick) || tick <= 0 || !fin(prezzo)) return null;
  return +(Math.floor((prezzo + 1e-9) / tick) * tick).toFixed(6);
}

/**
 * IL PIANO DI CHIUSURA RAPIDA. Puro.
 *
 * @param {object} a
 *   prezzoCarico    quanto abbiamo pagato il lato che possediamo (frazione, es. 0.65)
 *   manca           quante share servono per completare la coppia
 *   asksAltroLato   la scala degli ask dell'altro lato: [{price, size}, …]. Assente/vuota ⇒ nessun taker.
 *   tick, minSize   regole del venue; senza tick non si propone niente (mai un prezzo indovinato)
 *   tettoCents      il tetto della coppia; di difetto TETTO_COPPIA_CENTS
 * @returns {{ok:boolean, motivo:string|null, taker:{prezzo,size,livelli}|null,
 *            limite:{prezzo,size}|null, tettoCents:number, prezzoMassimo:number|null,
 *            coppiaTakerCents:number|null, scoperto:number}}
 */
function pianificaChiusuraRapida({
  prezzoCarico = null, manca = null, asksAltroLato = null,
  tick = null, minSize = null, tettoCents = TETTO_COPPIA_CENTS,
} = {}) {
  const tetto = fin(tettoCents) && tettoCents >= 100 && tettoCents <= 200 ? tettoCents : TETTO_COPPIA_CENTS;
  const vuoto = (motivo) => ({ ok: false, motivo, taker: null, limite: null, tettoCents: tetto,
    prezzoMassimo: null, coppiaTakerCents: null, scoperto: fin(manca) ? manca : 0 });

  if (!fin(prezzoCarico) || prezzoCarico <= 0) return vuoto('prezzo di carico non leggibile: il tetto della coppia non si calcola');
  if (!fin(manca) || manca <= 0) return vuoto('non manca niente per completare la coppia');
  if (!fin(tick) || tick <= 0) return vuoto('tick non leggibile: nessun prezzo viene indovinato');

  // IL PREZZO MASSIMO PAGABILE per l'altro lato, arrotondato giu' al tick.
  const massimoGrezzo = tetto / 100 - prezzoCarico;
  if (!(massimoGrezzo > 0)) {
    return vuoto(`il lato posseduto costa gia' ${(prezzoCarico * 100).toFixed(1)}¢: sopra il tetto di ${tetto}¢ non resta niente da pagare per l'altro lato`);
  }
  const prezzoMassimo = giuAlTick(massimoGrezzo, tick);
  if (!fin(prezzoMassimo) || prezzoMassimo <= 0) {
    return vuoto(`il prezzo massimo (${massimoGrezzo.toFixed(6)}) arrotondato al tick ${tick} non e' un prezzo utilizzabile`);
  }

  // ── LA CAMMINATA DELLA SCALA ────────────────────────────────────────────────────────────────────
  // Si prendono i livelli in ordine di prezzo crescente finche' stanno SOTTO il prezzo massimo. Un
  // livello con prezzo o size illeggibili interrompe la camminata invece di essere saltato: la scala
  // e' ordinata, e saltarne uno vorrebbe dire comprare a un prezzo peggiore credendo di comprare al
  // migliore. Fermarsi e' la lettura prudente.
  const scala = Array.isArray(asksAltroLato) ? asksAltroLato : [];
  const ordinata = scala
    .map((l) => ({ price: Number(l && l.price), size: Number(l && l.size) }))
    .sort((a, b) => a.price - b.price);

  let presa = 0;
  let peggiore = null;
  let livelli = 0;
  for (const l of ordinata) {
    if (!fin(l.price) || l.price <= 0 || !fin(l.size) || l.size <= 0) break;
    if (l.price > prezzoMassimo + 1e-12) break;      // oltre il tetto: qui il taker si ferma
    const quanta = Math.min(l.size, manca - presa);
    if (quanta <= 0) break;
    presa = +(presa + quanta).toFixed(6);
    peggiore = l.price;
    livelli += 1;
    if (presa >= manca - 1e-9) break;
  }

  // ── LE DUE GAMBE ────────────────────────────────────────────────────────────────────────────────
  // Il taker si propone al prezzo del livello PEGGIORE preso: un ordine a quel prezzo attraversa e si
  // esegue ai livelli migliori o uguali, quindi il costo reale e' <= a quello dichiarato. Dichiarare il
  // migliore invece del peggiore riempirebbe solo il primo livello e lascerebbe il resto scoperto.
  const sottoMinimo = (s) => fin(minSize) && minSize > 0 && s < minSize - 1e-9;
  let taker = null;
  if (presa > 0 && fin(peggiore)) {
    taker = sottoMinimo(presa) ? null : { prezzo: peggiore, size: presa, livelli };
  }
  const presaEffettiva = taker ? taker.size : 0;
  const resto = +(manca - presaEffettiva).toFixed(6);

  let limite = null;
  if (resto > 1e-9 && !sottoMinimo(resto)) limite = { prezzo: prezzoMassimo, size: resto };

  const coppiaTaker = taker ? +((prezzoCarico + taker.prezzo) * 100).toFixed(3) : null;
  const scoperto = +(manca - presaEffettiva - (limite ? limite.size : 0)).toFixed(6);

  if (!taker && !limite) {
    return { ...vuoto(fin(minSize) && manca < minSize
      ? `mancano ${manca} share, sotto il minimo del venue (${minSize}): ne' un taker ne' un limit sarebbero accettati`
      : 'nessuna gamba di chiusura utilizzabile'), prezzoMassimo };
  }

  return {
    ok: true,
    motivo: taker && !limite
      ? `il book copre tutte le ${manca} share sotto il tetto: taker a ${(taker.prezzo * 100).toFixed(1)}¢ su ${livelli} livello/i, coppia a ${coppiaTaker}¢`
      : taker
        ? `il book copre ${taker.size} share sotto il tetto (coppia a ${coppiaTaker}¢); le altre ${limite.size} restano a limit a ${(limite.prezzo * 100).toFixed(1)}¢, che tiene la coppia al tetto di ${tetto}¢`
        : `nessun livello sta sotto il tetto: tutte le ${limite.size} share vanno a limit a ${(limite.prezzo * 100).toFixed(1)}¢`,
    taker, limite, tettoCents: tetto, prezzoMassimo, coppiaTakerCents: coppiaTaker, scoperto,
  };
}

/**
 * IL CONTROLLO FINALE, e non e' ridondante. Riesegue l'aritmetica del tetto su un piano gia' costruito,
 * in modo che chi piazza possa rifiutarsi anche se questo modulo avesse sbagliato. E' lo stesso idioma
 * di `verificaConfinamento` nel relayer: la seconda lettura esiste per il giorno in cui qualcuno
 * aggiunge un ramo alla prima.
 */
function rispettaIlTetto(piano, prezzoCarico, tettoCents = TETTO_COPPIA_CENTS) {
  if (!piano || piano.ok !== true) return true;
  const tetto = fin(tettoCents) ? tettoCents : TETTO_COPPIA_CENTS;
  for (const g of [piano.taker, piano.limite]) {
    if (!g) continue;
    if (!fin(g.prezzo) || !fin(prezzoCarico)) return false;
    if ((prezzoCarico + g.prezzo) * 100 > tetto + 1e-9) return false;
  }
  return true;
}


/**
 * IL RIPOSIZIONAMENTO DI UN LATO RIMASTO SCOPERTO. Puro.
 *
 * ═══ QUANDO SERVE ═══════════════════════════════════════════════════════════════════════════════════
 * Dopo un fill su un lato solo, se la chiusura rapida non e' scattata o non ha completato la coppia,
 * oggi il sistema puo' TACERE del tutto: `planExit` (exit-plan.js:146) rifiuta di piazzare un'uscita
 * quando la banda premiante e' scesa sotto il prezzo di carico, e nessun altro percorso propone niente.
 * Risultato: posizione direzionale, zero ordini, zero premi. E' lo stato in cui il 9 agosto 2026 si
 * trovavano entrambe le posizioni London.
 *
 * ═══ LE DUE GAMBE, E FANNO LAVORI DIVERSI ═══════════════════════════════════════════════════════════
 *   · LATO POSSEDUTO — un SELL a +1% dal carico, schiacciato sul tetto della banda se lo supera. Cosi'
 *     l'attesa matura premi invece di essere gratis per il mercato. Due vincoli DURI: mai fuori banda,
 *     mai sotto il carico.
 *   · CONTROPARTE — un BUY della size mancante, al prezzo che tiene la coppia entro il tetto. E' la
 *     versione LIMIT della chiusura rapida: quando il taker non e' scattato, la coppia si completa
 *     comunque, solo aspettando.
 *
 * ═══ IL CASO CHE HA MOTIVATO LA REGOLA NON E' RISOLVIBILE SUL LATO POSSEDUTO, E VA DETTO ════════════
 * La regola chiede «+1% dal carico, sempre dentro la banda, mai sotto il carico». Quando la banda e'
 * INTERAMENTE sotto il carico — che e' esattamente il caso in cui oggi si tace — quei tre vincoli sono
 * incompatibili fra loro: non esiste un prezzo che li soddisfi tutti. Questa funzione non ne inventa
 * uno: restituisce `latoPosseduto: null` con il motivo, e propone comunque la CONTROPARTE, che invece
 * e' sempre prezzabile. Il silenzio si riduce, non sparisce — e sparire, li', vorrebbe dire vendere
 * sotto il carico, cioe' rompere il vincolo che la regola dichiara duro.
 *
 * @returns {{ok:boolean, motivo:string, latoPosseduto:{prezzo,size}|null, controparte:{prezzo,size}|null,
 *            latoPossedutoMotivo:string|null}}
 */
function pianificaRiposizionamentoScoperto({
  prezzoCarico = null, sizePosseduta = null, manca = null,
  bandaLo = null, bandaHi = null, tick = null, minSize = null,
  bandaHiControparte = null,
  profitPct = 1, tettoCents = TETTO_COPPIA_CENTS,
} = {}) {
  const no = (motivo) => ({ ok: false, motivo, latoPosseduto: null, controparte: null, latoPossedutoMotivo: motivo });
  if (!fin(prezzoCarico) || prezzoCarico <= 0) return no('prezzo di carico non leggibile');
  if (!fin(tick) || tick <= 0) return no('tick non leggibile: nessun prezzo viene indovinato');
  const sottoMin = (x) => fin(minSize) && minSize > 0 && x < minSize - 1e-9;

  // ── IL LATO POSSEDUTO ──────────────────────────────────────────────────────────────────────────
  // Arrotondato IN SU: in giu' consegnerebbe meno guadagno di quello promesso — stessa direzione di
  // `exit-plan.snapTo(..., 'up')`, e per la stessa ragione.
  let latoPosseduto = null;
  let latoPossedutoMotivo = null;
  // Vero SOLO quando il lato posseduto tace perche' la banda e' scesa sotto il carico. E' la condizione
  // che apre l'eccezione a «mai primi sul libro» sulla controparte — nessun altro silenzio la apre.
  let bandaSottoCarico = false;
  if (!fin(sizePosseduta) || sizePosseduta <= 0) {
    latoPossedutoMotivo = 'size posseduta non leggibile';
  } else if (sottoMin(sizePosseduta)) {
    latoPossedutoMotivo = `la posizione e' di ${sizePosseduta} share, sotto il minimo del venue (${minSize})`;
  } else {
    const obiettivo = +(Math.ceil((prezzoCarico * (1 + profitPct / 100) - 1e-9) / tick) * tick).toFixed(6);
    // Dentro la banda: se l'obiettivo la supera si scende al suo tetto — il prezzo piu' vicino a +1%
    // che resta premiante. Mai oltre, in nessun caso.
    const prezzo = fin(bandaHi) && obiettivo > bandaHi ? +(Math.floor((bandaHi + 1e-9) / tick) * tick).toFixed(6) : obiettivo;
    if (fin(bandaHi) && prezzo > bandaHi + 1e-9) {
      latoPossedutoMotivo = 'il prezzo calcolato uscirebbe dalla banda: non si propone';
    } else if (!(prezzo > prezzoCarico + 1e-9)) {
      // I TRE VINCOLI SONO INCOMPATIBILI. Non e' un errore di calcolo: la banda sta sotto il carico.
      bandaSottoCarico = true;
      latoPossedutoMotivo = `la banda premiante (fino a ${fin(bandaHi) ? (bandaHi * 100).toFixed(1) + '¢' : 'ignota'})`
        + ` e' sotto il prezzo di carico (${(prezzoCarico * 100).toFixed(1)}¢): nessun prezzo e' insieme dentro banda e sopra il carico.`
        + ' Non si vende in perdita per restare premiati';
    } else if (!(prezzo > 0) || prezzo >= 1) {
      latoPossedutoMotivo = `il prezzo calcolato (${prezzo}) e' fuori dai limiti del libro`;
    } else {
      latoPosseduto = { prezzo, size: sizePosseduta };
    }
  }

  // ── LA CONTROPARTE ─────────────────────────────────────────────────────────────────────────────
  // Sempre prezzabile finche' resta spazio sotto il tetto. Arrotondata GIU', come nella chiusura
  // rapida: verso l'alto si sforerebbe di una frazione di tick.
  let controparte = null;
  let controparteMotivo = null;
  const tetto = fin(tettoCents) && tettoCents >= 100 && tettoCents <= 200 ? tettoCents : TETTO_COPPIA_CENTS;
  if (!fin(manca) || manca <= 0) controparteMotivo = 'non manca niente per completare la coppia';
  else if (sottoMin(manca)) controparteMotivo = `mancano ${manca} share, sotto il minimo del venue (${minSize})`;
  else {
    const massimo = giuAlTick(tetto / 100 - prezzoCarico, tick);
    if (!fin(massimo) || massimo <= 0) controparteMotivo = `il carico ${(prezzoCarico * 100).toFixed(1)}¢ non lascia spazio sotto il tetto di ${tetto}¢`;
    else {
      // ── L'ECCEZIONE, E VALE SOLO QUI ──────────────────────────────────────────────────────────
      // Decisione dell'operatore, 9 agosto 2026. Quando il lato posseduto e' MUTO perche' la banda e'
      // scesa sotto il carico, la posizione non ha nessun ordine che la chiuda: resta direzionale e
      // senza premi a tempo indeterminato. In quel caso — e SOLO in quel caso — la controparte smette
      // di essere una quota che aspetta e diventa lo strumento che CHIUDE la coppia, quindi va messa
      // PRIMA ASSOLUTA sul libro dentro la banda invece che un tick dietro a chi c'e' gia'.
      //
      // IL COMPROMESSO, ACCETTATO ESPLICITAMENTE: si paga qualche centesimo per azione per stare in
      // cima alla coda invece che in fondo, in cambio di una chiusura rapida invece di un'attesa
      // indefinita. E' un costo certo e piccolo contro un blocco incerto e grande.
      //
      // COSA NON CAMBIA: il tetto della coppia (`massimo`) resta un limite DURO — si prende il piu'
      // BASSO fra il bordo della banda e il tetto, mai il piu' alto. E il lato POSSEDUTO resta
      // protetto dal «mai sotto il carico» esattamente come prima: questa eccezione non lo tocca.
      let prezzo = massimo;
      let primoAssoluto = false;
      if (bandaSottoCarico && fin(bandaHiControparte)) {
        const aggressivo = giuAlTick(bandaHiControparte, tick);
        if (fin(aggressivo) && aggressivo > 0) {
          prezzo = Math.min(aggressivo, massimo);
          primoAssoluto = true;
        }
      }
      // La size e' `manca`, cioe' esattamente quanto serve a pareggiare il lato posseduto: uguale e
      // contraria per costruzione, non per scelta.
      controparte = { prezzo, size: manca, primoAssoluto };
    }
  }

  if (!latoPosseduto && !controparte) {
    return { ok: false, motivo: `${latoPossedutoMotivo || 'lato posseduto non proponibile'} · ${controparteMotivo || 'controparte non proponibile'}`,
      latoPosseduto: null, controparte: null, latoPossedutoMotivo };
  }
  return {
    ok: true,
    motivo: [latoPosseduto ? `lato posseduto a ${(latoPosseduto.prezzo * 100).toFixed(1)}¢ (carico ${(prezzoCarico * 100).toFixed(1)}¢, dentro banda)` : `lato posseduto NON riposizionato: ${latoPossedutoMotivo}`,
      controparte ? `controparte ${controparte.size} share a ${(controparte.prezzo * 100).toFixed(1)}¢` : `controparte non proposta: ${controparteMotivo}`].join(' · '),
    latoPosseduto, controparte, latoPossedutoMotivo,
  };
}

module.exports = { pianificaChiusuraRapida, pianificaRiposizionamentoScoperto, rispettaIlTetto, leggiTetto, TETTO_COPPIA_CENTS, giuAlTick };

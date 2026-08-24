'use strict';
// lib/maker/ordini-di-uscita.js — IL PREZZO DECISO DALLA SCALA È VINCOLANTE.
//
// ═══ IL FATTO CHE HA PRODOTTO QUESTO MODULO — 24 agosto 2026, misurato sul vivo ═══════════════════
// Su `0x4d79d306` (carico 49,4¢) la scala d'uscita ha DECISO, e scritto nel giornale:
//     auto-close · modalita-chiusura-lato-posseduto-piazzato · SELL no 0.495
//     «banda sotto il carico: in modalita' chiusura si piazza comunque a 49.5¢ = carico +1 tick,
//      FUORI banda — nessun premio, ma si puo' uscire in pari»
// e 28 secondi dopo, al venue, e' arrivato **0.288**:
//     manual-place · sent · SELL no 0.288
//     priceAdjusted { inCoda: { from: 0.495, to: 0.288, mode: 'behind-best', bestOther: 0.281 } }
// cioe' `manual-order` ha applicato la regola di CODA — «un tick dietro il miglior ask altrui» —
// a un ordine che non stava quotando: stava USCENDO. §7 concede al massimo
// `min(5% del carico, un tick)` = 0,1¢, cioe' un pavimento di 49,3¢ e **$1,39** di perdita massima
// su 56,1 share; l'ordine partito a 28,8¢ ne autorizzava **$11,56**, cioe' **8,3 volte**.
//
// E lo stesso ciclo, sull'altra gamba: `auto-close` piazza il BUY di completamento a **0.516** —
// che non e' un prezzo di mercato ma `101¢ − carico`, il tetto della coppia al centesimo — e 31
// secondi dopo `band-exit` lo sposta a **0.708**, poi 0,717: coppia **121,1¢**, venti centesimi oltre
// un tetto che §4.6 descrive come «asserito in un punto solo». Nove cicli cosi'.
//
// ═══ LA REGOLA, IN UNA RIGA ══════════════════════════════════════════════════════════════════════
// **Per un ordine di USCITA il prezzo deciso dalla scala e' vincolante: nessun aggiustamento di coda,
// nessuna riscrittura, in nessun ramo.**
//
// ⚠ COSA E' UN «ORDINE DI USCITA», E PERCHE' LA MARCATURA STA ALL'ORIGINE. Sono le due forme che
// RIDUCONO esposizione: il SELL sulla gamba scoperta e il BUY che completa la coppia. Non si
// riconoscono dal prezzo ne' dal lato — un BUY puo' essere l'una o l'altra cosa — quindi non si
// indovinano a valle: le marca **chi le costruisce** (`auto-close.chiudendo`, il punto unico che gia'
// timbra la GTD di chiusura, quattro chiamanti), e tutti gli altri le LEGGONO. Un ordine che apre non
// passa di li' e non e' toccato da niente di questo file — `riposizionaDopoChiusura` compreso, che
// APRE due gambe di liquidita' ed e' gia' escluso da `chiudendo` per la stessa ragione.
//
// ⚠ PURO. Zero `require` di superfici che decidono o agiscono: qui si giudica e basta. Il registro su
// disco sta in fondo ed e' l'unica parte che tocca il filesystem, separata apposta perche' la
// DECISIONE resti verificabile senza montare niente.
//
// ⚠ NON E' UN SECONDO TETTO DELLA COPPIA. `verdettoTettoCoppia` NON conosce nessun numero: pretende
// `tettoCoppiaCents` dal chiamante, che lo prende da `chiusura-rapida.TETTO_COPPIA_CENTS` — la
// definizione unica. Un letterale `101` qui dentro sarebbe la seconda copia di un numero che deve
// restare uno solo (reperto D1), su un limite di rischio.

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('../safety/store');

/** Il nome del campo che marca un ordine come uscita. UN posto, cosi' non diventa due stringhe. */
const CAMPO_USCITA = 'uscita';
/** Il campo che porta il prezzo deciso dalla scala accanto al prezzo dell'ordine. */
const CAMPO_PREZZO_DECISO = 'prezzoDeciso';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Questo spec e' un ordine di uscita? Si guarda `=== true`, mai la truthiness: una stringa vuota, uno
 * zero o un oggetto non devono poter armare o disarmare una regola di rischio per distrazione.
 */
function eOrdineDiUscita(spec) {
  return !!spec && spec[CAMPO_USCITA] === true;
}

/**
 * Il prezzo che la scala ha deciso per questo spec. Ripiega su `price` — che per un ordine di uscita
 * appena costruito E' il prezzo deciso — cosi' un chiamante che marca `uscita` senza dichiarare il
 * prezzo deciso ottiene comunque la regola, invece di ottenerne il silenzio.
 */
function prezzoDecisoDi(spec) {
  if (!spec) return null;
  const esplicito = Number(spec[CAMPO_PREZZO_DECISO]);
  if (fin(esplicito) && esplicito > 0) return esplicito;
  const p = Number(spec.price);
  return fin(p) && p > 0 ? p : null;
}

/**
 * ① IL DIVIETO DI AGGIUSTAMENTO — puro.
 *
 * Un ramo (la coda «mai primi», il ricalcolo dal mid vivo, il rientro in banda) PROPONE un prezzo.
 * Su un ordine di uscita la proposta non si applica mai. Questa funzione dice se la proposta muoveva
 * davvero il prezzo, e con quali numeri va scritta a verbale.
 *
 * ⚠ SI CALCOLA COMUNQUE, E POI NON SI APPLICA. Non e' spreco: se il ramo non venisse nemmeno
 * interrogato, «un aggiustamento voleva muovere il prezzo» non sarebbe osservabile — e il difetto del
 * 24 agosto e' vissuto sette ore proprio perche' nessuno vedeva il delta. La riga costa una riga; non
 * vederla e' costata un ordine a 8,3 volte la concessione consentita.
 *
 * ⚠ LA TOLLERANZA E' `tick/1000`, la stessa che `manual-order` e `auto-reprice` usano gia' per dire
 * «e' lo stesso prezzo»: non se ne introduce una terza.
 *
 * @returns {{muove:boolean, prezzoDeciso:number|null, prezzoProposto:number|null,
 *            deltaCents:number|null, ramo:string, motivo:string}}
 */
function verdettoAggiustamento({ prezzoDeciso = null, prezzoProposto = null, ramo = 'ignoto', tick = null } = {}) {
  const base = { prezzoDeciso: fin(prezzoDeciso) ? prezzoDeciso : null,
    prezzoProposto: fin(prezzoProposto) ? prezzoProposto : null, ramo: String(ramo || 'ignoto') };
  if (!fin(prezzoDeciso) || !fin(prezzoProposto)) {
    return { ...base, muove: false, deltaCents: null,
      motivo: 'prezzo deciso o proposto non leggibile: non si giudica un aggiustamento su un numero che non si e\' letto' };
  }
  const tol = fin(tick) && tick > 0 ? tick / 1000 : 1e-9;
  const delta = prezzoProposto - prezzoDeciso;
  const muove = Math.abs(delta) > tol;
  return {
    ...base, muove, deltaCents: +(delta * 100).toFixed(4),
    motivo: muove
      ? `il ramo «${base.ramo}» proporrebbe ${prezzoProposto} al posto del prezzo deciso dalla scala `
        + `${prezzoDeciso} (${(delta * 100).toFixed(3)}¢): su un ordine di USCITA il prezzo deciso e' `
        + 'vincolante e la proposta NON viene applicata'
      : `il ramo «${base.ramo}» propone lo stesso prezzo deciso (${prezzoDeciso}): nessuno spostamento`,
  };
}

/**
 * ② IL CONTROLLO TERMINALE SULLA COPPIA — puro, e si fa sul prezzo di INVIO.
 *
 * «Nessun BUY di completamento parte se la coppia, RICALCOLATA SUL PREZZO EFFETTIVO DI INVIO, supera
 * il tetto.» Il ricalcolo sul prezzo di invio e non su quello di decisione e' tutta la differenza: il
 * 24 agosto la decisione era 0,516 — dentro il tetto al centesimo — e a partire era 0,717. Un
 * controllo sul prezzo deciso avrebbe detto «ammesso» su un ordine che rompeva il tetto di 20,1¢.
 *
 * ⚠ FAIL-CLOSED SU OGNI INGRESSO. Carico non leggibile, prezzo non leggibile, tetto non leggibile ⇒
 * **non ammesso**. Un BUY di completamento che non si puo' giudicare e' un BUY che non parte: la
 * direzione opposta lascerebbe passare proprio il caso che non si e' saputo misurare.
 * ⚠ SOLO IL BUY. Un SELL di uscita non compra niente e non forma nessuna coppia: chiederglielo
 * sarebbe applicare a chi VENDE una regola nata per chi COMPRA — la stessa inversione di segno che
 * §4.2 documenta sul tetto di esposizione.
 *
 * @returns {{ammesso:boolean, coppiaCents:number|null, tettoCents:number|null, motivo:string}}
 */
function verdettoTettoCoppia({ side = null, carico = null, prezzoInvio = null, tettoCoppiaCents = null } = {}) {
  if (String(side).toUpperCase() !== 'BUY') {
    return { ammesso: true, coppiaCents: null, tettoCents: null,
      motivo: 'non e\' un BUY di completamento: il tetto della coppia non si applica' };
  }
  if (!fin(tettoCoppiaCents) || tettoCoppiaCents <= 0) {
    return { ammesso: false, coppiaCents: null, tettoCents: null,
      motivo: 'tetto della coppia non leggibile: un BUY di completamento non parte contro un limite che non si e\' letto' };
  }
  if (!fin(carico) || carico <= 0) {
    return { ammesso: false, coppiaCents: null, tettoCents: tettoCoppiaCents,
      motivo: 'carico non leggibile: la coppia non e\' calcolabile e il BUY di completamento non parte' };
  }
  if (!fin(prezzoInvio) || prezzoInvio <= 0) {
    return { ammesso: false, coppiaCents: null, tettoCents: tettoCoppiaCents,
      motivo: 'prezzo di invio non leggibile: la coppia non e\' calcolabile e il BUY di completamento non parte' };
  }
  const coppiaCents = +((carico + prezzoInvio) * 100).toFixed(4);
  // ⚠ Il confronto e' in CENTESIMI e con una tolleranza di un millesimo di centesimo: 101,0000¢ passa,
  // 101,0011¢ no. Senza la tolleranza un arrotondamento in virgola mobile rifiuterebbe la coppia
  // esatta al tetto, che e' proprio quella che la scala costruisce di proposito.
  const ammesso = coppiaCents <= tettoCoppiaCents + 1e-3;
  return {
    ammesso, coppiaCents, tettoCents: tettoCoppiaCents,
    motivo: ammesso
      ? `coppia ${coppiaCents.toFixed(2)}¢ = carico ${(carico * 100).toFixed(2)}¢ + invio ${(prezzoInvio * 100).toFixed(2)}¢, entro il tetto di ${tettoCoppiaCents}¢`
      : `coppia ${coppiaCents.toFixed(2)}¢ = carico ${(carico * 100).toFixed(2)}¢ + invio ${(prezzoInvio * 100).toFixed(2)}¢: `
        + `SUPERA il tetto di ${tettoCoppiaCents}¢ di ${(coppiaCents - tettoCoppiaCents).toFixed(2)}¢. `
        + 'Un completamento oltre il tetto e\' una perdita garantita al fill, non un\'uscita.',
  };
}

// ══ IL REGISTRO SU DISCO ════════════════════════════════════════════════════════════════════════
// ⚠ PERCHE' SERVE UN FILE E NON LA MEMORIA. A marcare l'ordine e' `auto-close` dentro **agent40**; a
// decidere se spostarlo e' `auto-reprice`, che gira nello **stesso** processo ma su un giro diverso e
// su ordini **riletti dal venue** — dove la nostra marcatura non esiste, perche' il venue conosce
// prezzo, lato e size, non le nostre intenzioni. Un ordine che torna dal venue senza sapere di essere
// un'uscita e' esattamente il caso in cui `band-exit` l'ha spostato nove volte.
// ⚠ E PORTA IL PREZZO DECISO, non solo il flag: serve a `close-sell-floor` per confrontarsi con il
// prezzo della SCALA invece che con quello dell'ordine vivo. Un pavimento che difende il prezzo
// dell'ordine vivo difende anche un prezzo gia' sceso sotto di se': non e' un pavimento, e' un'eco.

const FILE = path.join(DATA_DIR, 'ordini-di-uscita.json');
/** Un ordine di chiusura vive al massimo 33 minuti (GTD_CHIUSURA_SECONDS): oltre e' certamente morto. */
const VOCE_MAX_AGE_MS = 60 * 60 * 1000;

function leggiRegistro() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object' || !j.voci || typeof j.voci !== 'object') {
      return { leggibile: false, voci: {}, motivo: 'registro presente ma malformato' };
    }
    return { leggibile: true, voci: j.voci, motivo: 'letto' };
  } catch (e) {
    // ⚠ UN FILE ASSENTE NON E' UN ERRORE — e' il primo avvio — ma NON E' NEMMENO «leggibile e vuoto».
    // La distinzione conta: chi decide se spostare un ordine deve poter distinguere «so che non e'
    // un'uscita» da «non lo so», e le due cose portano a due comportamenti opposti.
    const assente = e && e.code === 'ENOENT';
    return { leggibile: assente, voci: {}, motivo: assente ? 'registro assente: nessuna uscita marcata' : `registro illeggibile: ${e.message}` };
  }
}

/** Marca un orderId come uscita, col prezzo che la scala aveva deciso. Non solleva mai. */
function registraUscita({ orderId = null, marketId = null, book = null, side = null, prezzoDeciso = null, at = Date.now() } = {}) {
  if (!orderId) return { scritto: false, motivo: 'orderId assente' };
  try {
    const r = leggiRegistro();
    const voci = { ...r.voci };
    voci[String(orderId)] = { orderId: String(orderId), marketId, book, side, prezzoDeciso: fin(prezzoDeciso) ? prezzoDeciso : null, at };
    // Potatura per eta': il registro non deve crescere per sempre, e una voce piu' vecchia della vita
    // massima di un ordine di chiusura descrive un ordine che al venue non c'e' piu'.
    for (const [k, v] of Object.entries(voci)) {
      if (!v || !fin(Number(v.at)) || at - Number(v.at) > VOCE_MAX_AGE_MS) delete voci[k];
    }
    const { writeStoreAtomic } = require('../safety/store');
    writeStoreAtomic(FILE, { v: 1, aggiornatoAt: at, voci });
    return { scritto: true, motivo: 'registrato' };
  } catch (e) {
    // ⚠ NON SOLLEVA. Se il registro non si scrive, l'ordine e' gia' partito: far fallire il
    // piazzamento a cose fatte non lo riporterebbe indietro, e trasformerebbe un guasto di
    // osservabilita' in un guasto di esecuzione.
    return { scritto: false, motivo: `registro non scritto: ${e.message}` };
  }
}

/**
 * Cosa sappiamo di un ordine vivo riletto dal venue.
 *
 * ⚠ FAIL-CLOSED, MA STRETTO. Se il registro non e' leggibile non si dichiara «non e' un'uscita»: si
 * risponde `noto:false`, e chi decide sceglie la direzione prudente **solo dove un'uscita puo'
 * esistere** — cioe' dove c'e' una posizione. Rispondere «non e' un'uscita» riporterebbe il difetto
 * del 24 agosto ogni volta che il file si rompe; rispondere «e' un'uscita» a tutto fermerebbe il
 * riprezzo dell'intero libro. La domanda giusta e' la terza: «lo so?».
 */
function statoOrdine(orderId, registro = null) {
  const r = registro || leggiRegistro();
  const v = r.voci[String(orderId)];
  if (v) return { noto: true, uscita: true, prezzoDeciso: fin(Number(v.prezzoDeciso)) ? Number(v.prezzoDeciso) : null, motivo: 'marcato come uscita all\'origine' };
  if (!r.leggibile) return { noto: false, uscita: null, prezzoDeciso: null, motivo: r.motivo };
  return { noto: true, uscita: false, prezzoDeciso: null, motivo: 'non e\' fra gli ordini di uscita marcati' };
}

function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (t, c, d) => { if (c) { pass += 1; console.log('  ok  ', t); } else { fail += 1; console.log('  FAIL', t, d || ''); } };

  console.log('\n① la marcatura si legge `=== true`, non per truthiness');
  ok('spec marcato', eOrdineDiUscita({ uscita: true }) === true);
  ok('spec non marcato', eOrdineDiUscita({ price: 0.5 }) === false);
  ok('truthiness non arma', eOrdineDiUscita({ uscita: 1 }) === false && eOrdineDiUscita({ uscita: 'si' }) === false);
  ok('spec assente non solleva', eOrdineDiUscita(null) === false);

  console.log('\n② il caso vero del 24 agosto: 0.495 deciso, 0.288 proposto dalla coda');
  const v = verdettoAggiustamento({ prezzoDeciso: 0.495, prezzoProposto: 0.288, ramo: 'inCoda', tick: 0.001 });
  ok('lo spostamento e\' riconosciuto', v.muove === true, v.motivo);
  ok('  col delta in centesimi', Math.abs(v.deltaCents - -20.7) < 1e-6, `${v.deltaCents}`);
  ok('  e col nome del ramo', v.ramo === 'inCoda');
  ok('stesso prezzo ⇒ non muove', verdettoAggiustamento({ prezzoDeciso: 0.495, prezzoProposto: 0.495, ramo: 'inCoda', tick: 0.001 }).muove === false);
  ok('sotto la tolleranza tick/1000 ⇒ non muove',
    verdettoAggiustamento({ prezzoDeciso: 0.495, prezzoProposto: 0.4950005, ramo: 'x', tick: 0.001 }).muove === false);
  ok('prezzo non leggibile ⇒ non si giudica, e non muove',
    verdettoAggiustamento({ prezzoDeciso: null, prezzoProposto: 0.288, ramo: 'x', tick: 0.001 }).muove === false);

  console.log('\n③ il tetto della coppia sul prezzo di INVIO');
  const t = 101;
  ok('il caso vero: carico 0.494 + invio 0.717 = 121,1¢ ⇒ RIFIUTATO',
    verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: 0.717, tettoCoppiaCents: t }).ammesso === false);
  const esatto = verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: 0.516, tettoCoppiaCents: t });
  ok('  e la coppia ESATTA al tetto passa (0.494 + 0.516 = 101,0¢)', esatto.ammesso === true, esatto.motivo);
  ok('  un tick oltre non passa',
    verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: 0.517, tettoCoppiaCents: t }).ammesso === false);
  ok('il SELL non e\' toccato', verdettoTettoCoppia({ side: 'SELL', carico: 0.494, prezzoInvio: 0.9, tettoCoppiaCents: t }).ammesso === true);
  console.log('  fail-closed su ogni ingresso:');
  ok('  tetto non leggibile ⇒ NON ammesso', verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: 0.5, tettoCoppiaCents: null }).ammesso === false);
  ok('  carico non leggibile ⇒ NON ammesso', verdettoTettoCoppia({ side: 'BUY', carico: null, prezzoInvio: 0.5, tettoCoppiaCents: t }).ammesso === false);
  ok('  prezzo non leggibile ⇒ NON ammesso', verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: null, tettoCoppiaCents: t }).ammesso === false);
  // ⚠ SI DIFENDE LA PROPRIETA', NON IL SORGENTE (§5.3): un test che cerca il letterale «101» nel testo
  // della funzione e' verde durante la lavorazione e rosso appena un commento cambia. La domanda vera
  // e' «il tetto viene DAVVERO dal parametro?», e si risponde muovendo il parametro.
  ok('  il tetto viene dal chiamante: due tetti diversi ⇒ due verdetti diversi sullo stesso prezzo',
    verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: 0.717, tettoCoppiaCents: 101 }).ammesso === false
    && verdettoTettoCoppia({ side: 'BUY', carico: 0.494, prezzoInvio: 0.717, tettoCoppiaCents: 130 }).ammesso === true);

  console.log('\n④ il prezzo deciso ripiega su `price`, ma l\'esplicito vince');
  ok('esplicito', prezzoDecisoDi({ price: 0.288, prezzoDeciso: 0.495 }) === 0.495);
  ok('ripiego su price', prezzoDecisoDi({ price: 0.495 }) === 0.495);
  ok('niente da leggere ⇒ null', prezzoDecisoDi({}) === null);

  console.log('\n⑤ il registro distingue «non e\' un\'uscita» da «non lo so»');
  const rVuoto = { leggibile: true, voci: {}, motivo: 'x' };
  ok('registro leggibile e vuoto ⇒ noto, non uscita', (() => { const s = statoOrdine('0xabc', rVuoto); return s.noto === true && s.uscita === false; })());
  const rRotto = { leggibile: false, voci: {}, motivo: 'illeggibile' };
  ok('registro illeggibile ⇒ NON noto (mai «non e\' un\'uscita»)', (() => { const s = statoOrdine('0xabc', rRotto); return s.noto === false && s.uscita === null; })());
  const rPieno = { leggibile: true, voci: { '0xabc': { orderId: '0xabc', prezzoDeciso: 0.495, at: Date.now() } }, motivo: 'x' };
  ok('voce presente ⇒ uscita, col prezzo della scala', (() => { const s = statoOrdine('0xabc', rPieno); return s.uscita === true && s.prezzoDeciso === 0.495; })());
  ok('  e una voce presente vale anche se il registro fosse illeggibile in generale',
    statoOrdine('0xabc', { leggibile: false, voci: rPieno.voci, motivo: 'x' }).uscita === true);

  console.log(`\nordini di uscita: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = {
  CAMPO_USCITA, CAMPO_PREZZO_DECISO, VOCE_MAX_AGE_MS, FILE,
  eOrdineDiUscita, prezzoDecisoDi, verdettoAggiustamento, verdettoTettoCoppia,
  leggiRegistro, registraUscita, statoOrdine, selfcheck,
};

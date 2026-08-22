'use strict';

/**
 * LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — §5 punto 138.
 *
 * ═══ IL FATTO CHE LA RENDE NECESSARIA ═══════════════════════════════════════════════════════════
 * Il 13 agosto 2026 la posizione NO di 58,8 share su `0xcd126ec4` è rimasta scoperta **8,2 ore**.
 * Nessuna singola regola aveva sbagliato: il tetto per mercato rifiutava la gamba NO (che APRE, ed è
 * giusto), il pavimento di profondità rifiutava la gamba YES (la banda offriva $42 contro un pavimento
 * di $171, misurato — mediana del rapporto 0,28 su 157 campioni, cioè il libro era davvero sottile per
 * tutte le sette ore). Il bot **adattava anche il prezzo**: 11 prezzi distinti su 17 mid distinti, cioè
 * NON era il vizio dei 114 rifiuti identici di §5 p.120.
 *
 * Sbagliava il SISTEMA, in un punto solo: **nessuno guardava da quanto tempo la posizione era scoperta.**
 * La gerarchia di §4.6 ha un solo orologio — i 60 minuti del Livello 2 — e alla sua scadenza il Livello 3
 * **cancella il completamento a riposo e ripiega sull'uscita ordinaria**; l'uscita ordinaria risponde
 * `no-target` perché la banda è scesa sotto il carico; e da lì si ripete identica per sempre. Misurato:
 * `merge-livello-3` con `attesaMin` che cresce 60,3 → 66,4 e **la stessa identica azione a ogni giro**.
 * Il risultato è il peggiore dei tre: la posizione resta scoperta E senza nemmeno un ordine che maturi
 * premi, perché quello che c'era è stato cancellato.
 *
 * ═══ LE SOGLIE VENGONO DAI DATI, NON DA UN'INTUIZIONE ═══════════════════════════════════════════
 * Ricostruiti dal giornale gli episodi di scopertura delle 48 ore (24 episodi su 19 mercati), la
 * distribuzione è **bimodale**, ed è questo che rende le soglie leggibili:
 *
 *   · episodi CHIUSI (la posizione è tornata coperta): **7**, mediana **10,5 min**, q75 **29,3 min**.
 *     Sei su sette sotto la mezz'ora. Uno solo ha superato l'ora (204 min).
 *   · episodi ANCORA APERTI: **17**, mediana **126,5 min**, massimo **553,7 min** (9,2 h).
 *
 * Cioè: una scopertura sana si chiude in **dieci minuti**, e oltre l'ora praticamente non si chiude più
 * da sola. Le soglie cadono dove la distribuzione si spezza, non su cifre tonde scelte a piacere.
 *
 * ═══ LA REGOLA DI COSTRUZIONE DELLA SCALA ══════════════════════════════════════════════════════
 * **Ogni gradino apre UNA via nuova, e nessun gradino tocca una regola di rischio.** In particolare:
 *   · «mai primo sul libro» non è toccato — questo modulo non produce prezzi, produce un PAVIMENTO;
 *     il prezzo lo sceglie il motore, che applica la Regola 1 come sempre;
 *   · la banda premiante non è toccata — la concessione vive DENTRO la banda per costruzione, perché
 *     è esattamente il caso «la banda è scesa sotto il carico», cioè il bordo alto della banda sta
 *     sotto il carico e quindi un prezzo fra i due è dentro la banda;
 *   · il tetto della coppia (`strategia-merge` e `chiusura-rapida`, entrambi 101¢ dal 15 agosto
 *     2026) e il pavimento di profondità non sono toccati da questo modulo.
 *
 * @module urgenza-scoperto
 */

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * LE SOGLIE, IN MINUTI. Si cambiano SOLO qui.
 *
 * 30  · q75 delle scoperture che si sono chiuse davvero (29,3 min): oltre questo punto pretendere
 *       ancora un GUADAGNO da una posizione che il mercato ha già superato è ciò che la tiene aperta.
 * 60  · ingresso nel regime patologico: oltre l'ora una scopertura non si chiude quasi più da sola
 *       (mediana degli episodi ancora aperti 126,5 min). Da qui si accetta una perdita limitata pur
 *       di non restare direzionali. Era 120 fino al 15 agosto 2026 — vedi la nota sotto `SOGLIE_MIN`.
 * 240 · nessuna scopertura ha mai superato le quattro ore ed è poi rientrata. È un guasto, e va gridato.
 *
 * ⚠ TRE SOGLIE E NON QUATTRO, E LA RAGIONE È UNA REGOLA DI QUESTO REPO. La prima stesura aveva un
 * gradino a 60 minuti che «non abbandonava la copertura a riposo» — e non serviva a niente: nel ramo
 * `no-target` il ciclo esce con `continue` PRIMA di arrivare alla cancellazione del completamento,
 * quindi quella copertura non veniva già cancellata. Era un gradino che dichiarava un'azione senza
 * consumarla da nessuna parte, cioè la classe di difetto «dep non cablata» vista dall'altro verso.
 * Un gradino che non apre una via non è un gradino: è una riga di documentazione travestita.
 */
// ⚠ `peggiorativa` 120 → 60 MINUTI, decisione dell'operatore del 15 agosto 2026: «se dopo 60 min ancora
// niente, molla accettando circa −0,89¢». Non e' una soglia tirata a indovinare e non contraddice la
// misura che aveva prodotto il 120: quella diceva che oltre l'ora una scopertura non si chiude quasi
// piu' da sola (mediana degli episodi aperti 126,5 min), cioe' che a 60 minuti si e' GIA' nel regime
// patologico — 120 era il centro di quella popolazione, 60 e' il suo ingresso. §5-bis p.163 misura poi
// cosa fanno li' i maker che guadagnano: **smontano la gamba a −0,89¢ mediani in 156 s**, e il bot
// concedeva la stessa cosa ~46 volte piu' tardi.
const SOGLIE_MIN = Object.freeze({ pareggio: 30, peggiorativa: 60, anomalia: 240 });

/**
 * IL TETTO DI PERDITA DELLA CHIUSURA PEGGIORATIVA — dichiarato, e doppio.
 *
 * ⚠ PERCHÉ SI ACCETTA DI PERDERE QUALCOSA. L'alternativa a una chiusura peggiorativa **non è zero**:
 * è tenere un'esposizione direzionale il cui esito peggiore vale 100¢/share. È lo stesso ragionamento
 * con cui §4.6 accetta una coppia sopra la pari — lì si paga per completarla, qui per smontarla, e dal
 * 15 agosto 2026 le due concessioni valgono **un centesimo** entrambe. Questa resta la più piccola.
 *
 * ⚠ DUE LIMITI, E IL PIÙ STRETTO VINCE.
 *   · `CONCESSIONE_TICK_MAX` — in TICK e non in percentuale, perché il prezzo vive su una griglia:
 *     una concessione che non è esprimibile sulla griglia non è una concessione, è un arrotondamento.
 *   · `PERDITA_MAX_FRAZIONE = 0,05` — il 5% del carico. Serve dove il primo non basta: su un token da
 *     10¢ con tick 1¢, due tick sono il **20%**, e la stessa costante direbbe due cose diverse a
 *     seconda del prezzo. Sul carico di 43¢ del caso reale i due tick valgono il 4,65%, quindi passano;
 *     su un carico di 10¢ il clamp morde e la concessione scende a un tick.
 *
 * Costo massimo, misurato sulla posizione più grande che questa configurazione possa aprire ($61,25 al
 * tetto per mercato, ~62,5 share): 1 tick da 1¢ = **$0,63**. Contro un'esposizione direzionale che,
 * non chiusa, vale l'intero nozionale.
 */
// ⚠ 2 → 1 TICK, decisione dell'operatore del 15 agosto 2026. La resa arriva prima (60 min invece di
// 120) e concede MENO: su tick 1¢ — il tick dei tre mercati di questa prova — un tick vale **−1,00¢**,
// che e' la traduzione sulla griglia dei **−0,89¢** mediani misurati in §5-bis p.162 su chi rivende la
// gamba. Un secondo tick sarebbe il doppio di quel dato, e non c'e' niente che lo sostenga.
const CONCESSIONE_TICK_MAX = 1;
// ⚠ IL 5% NON E' STATO TOCCATO, ed e' il belt che decide sui token economici. Su un carico di 9,5¢
// (mercato «1 Fed rate cut», mid 0,095) un tick intero sarebbe il 10,5% del carico, quindi la
// concessione viene tagliata a ZERO e la gamba non si molla: e' un limite di rischio, e allentarlo e'
// una decisione dell'operatore, non un dettaglio di questa configurazione. Dichiarato invece di
// scoperto dopo.
const PERDITA_MAX_FRAZIONE = 0.05;

/** Le etichette dei quattro gradini, nell'ordine. */
const ETICHETTE = Object.freeze(['normale', 'pareggio', 'peggiorativa', 'anomalia']);

/**
 * IL GRADINO DI URGENZA DA QUANTO TEMPO LA POSIZIONE È SCOPERTA.
 *
 * ⚠ TEMPO NON LEGGIBILE ⇒ GRADINO 0, cioè il comportamento di oggi. Un orologio che non si è potuto
 * leggere non è un orologio fermo a zero, ma qui l'unica direzione prudente è non concedere niente:
 * la concessione costa capitale reale, e non si paga contro un'assenza di informazione.
 *
 * @param {object}  a
 * @param {number?} a.scopertoDaMin  da quanti minuti la posizione è scoperta (`leggiChiusura().daMin`)
 * @returns {{livello:number, etichetta:string, minuti:number|null, concessioneTick:number,
 *            profitPct:number, anomaliaGrave:boolean, motivo:string}}
 */
function livelloUrgenza({ scopertoDaMin = null } = {}) {
  const m = fin(scopertoDaMin) && scopertoDaMin >= 0 ? scopertoDaMin : null;
  if (m === null) {
    return {
      livello: 0, etichetta: ETICHETTE[0], minuti: null, concessioneTick: 0, profitPct: 1,
      anomaliaGrave: false,
      motivo: 'da quanto è scoperta non è leggibile: nessuna concessione — non si paga contro un dato che non si è letto',
    };
  }
  let livello = 0;
  if (m >= SOGLIE_MIN.anomalia) livello = 3;
  else if (m >= SOGLIE_MIN.peggiorativa) livello = 2;
  else if (m >= SOGLIE_MIN.pareggio) livello = 1;

  // Ogni gradino apre UNA via nuova, e la apre DAVVERO — cioè qualcuno la consuma.
  //   0 · niente di nuovo: la gerarchia di §4.6 fa il suo corso
  //   1 · l'uscita può scendere **fino al carico** (obiettivo 0% invece di +1%): è il gradino che
  //       scioglie il `no-target` del caso reale, dove il bordo della banda era ESATTAMENTE il carico.
  //       Uscire in pareggio NON è perdere: è smettere di pretendere un guadagno da una posizione che
  //       il mercato ha già superato, e intanto quell'ordine matura premi mentre aspetta.
  //   2 · chiusura peggiorativa entro il tetto dichiarato sopra
  //   3 · come 2, più l'anomalia grave nel log e nel giornale finché dura. NON apre una quarta via:
  //       al gradino 2 sono già tutte aperte, e inventarne un'altra vorrebbe dire violare una regola
  //       di rischio. Qui il bot dichiara di non farcela invece di tacere.
  const concessioneTick = livello >= 2 ? CONCESSIONE_TICK_MAX : 0;
  const profitPct = livello >= 1 ? 0 : 1;
  return {
    livello, etichetta: ETICHETTE[livello], minuti: +m.toFixed(1), concessioneTick, profitPct,
    anomaliaGrave: livello >= 3,
    motivo: livello === 0
      ? `scoperta da ${m.toFixed(0)} min: sotto la soglia del pareggio (${SOGLIE_MIN.pareggio} min), nessuna via nuova`
      : `scoperta da ${m.toFixed(0)} min ⇒ urgenza ${livello} (${ETICHETTE[livello]}): `
        + (livello === 1 ? `l'uscita può scendere fino al carico (obiettivo ${profitPct}%)`
          : `l'uscita può scendere fino a ${concessioneTick} tick sotto il carico, e mai oltre il ${PERDITA_MAX_FRAZIONE * 100}%`)
        + (livello >= 3 ? ' — e oltre le quattro ore nessuna scopertura misurata è mai rientrata: è un guasto, e si dichiara' : ''),
  };
}

/**
 * IL PAVIMENTO DI PREZZO CONCESSO, cioè il prezzo più basso a cui si accetta di uscire.
 *
 * È l'unica aritmetica della concessione, e vive in un punto solo: `planExit` la importa da qui invece
 * di riscriverla, o nascerebbe la seconda copia di un limite di rischio (rilevatore D1).
 *
 * ═══ DUE NUMERI, E LA DIFFERENZA NON È UN DETTAGLIO — 22 agosto 2026 ════════════════════════════
 * `pavimento` è il limite ESATTO e serve a CONFRONTARE («la banda arriva sotto il pavimento?»).
 * `pavimentoGriglia` è lo stesso limite portato sulla griglia del mercato e serve a PREZZARE.
 *
 * IL DIFETTO CHE CHIUDE, misurato sul giornale: il pavimento è una frazione del carico (il 5%, R7) e
 * non cade quasi mai su un tick — `0,68 × 0,95 = 0,646` e `0,37 × 0,95 = 0,3515` non sono prezzi
 * esprimibili su una griglia da 1¢. `auto-close.inseguiIlBid` lo usa come `Math.max`, quindi quando il
 * bid sta sotto il pavimento il PREZZO DELL'ORDINE diventa il pavimento stesso, e il guard condiviso
 * lo rifiuta con `OFF_TICK`. Rifiuti veri nel giornale: **25** su `0x4757745c` (22/08, 17:47→18:14) e
 * **107** su `0xac3ee338` (20-21/08) — questi ultimi come `skip-remainder-below-min-size` con codici
 * `OFF_TICK,BELOW_MIN_SIZE`, dove la deroga sul minimo non si applica proprio perché c'è OFF_TICK.
 *
 * ⚠ SI ARROTONDA IN SU, E LA DIREZIONE È OBBLIGATA: in giù si venderebbe SOTTO il pavimento della
 * scala del §7, cioè si concederebbe più perdita di quella che il gradino consente. In su se ne
 * concede di MENO. Il tappo del 5% non si sposta: può solo stringersi sulla griglia.
 *
 * ⚠ E IL CONFRONTO RESTA SUL NUMERO ESATTO: spostare anche quello cambierebbe chi passa e chi no
 * (il ramo «pareggio non basta» di `planExit`), che è una decisione di rischio e non un arrotondamento.
 * Sul percorso in banda le due cose non possono contraddirsi: `b.hi` sta già sulla griglia, quindi
 * `b.hi >= pavimento` implica `b.hi >= pavimentoGriglia` — l'arrotondamento non può spingere il prezzo
 * fuori dalla banda. È asserito, non promesso.
 *
 * @returns {{pavimento:number|null, pavimentoGriglia:number|null, tickConcessi:number,
 *            limitatoDa:string|null, motivo:string}}
 */
function pavimentoConcesso({ carico = null, tick = null, concessioneTick = 0 } = {}) {
  const no = (motivo) => ({ pavimento: null, pavimentoGriglia: null, tickConcessi: 0, limitatoDa: null, motivo });
  if (!fin(carico) || carico <= 0) return no('carico non leggibile: nessuna concessione');
  if (!fin(tick) || tick <= 0) return no('tick non leggibile: nessuna concessione');
  // ⚠ `concessioneTick` È IL CANCELLO, NON PIÙ LA QUANTITÀ (R7, 18 agosto 2026): dice se il gradino 2
  // è stato raggiunto. Quanto si concede lo decide `PERDITA_MAX_FRAZIONE`, qui sotto.
  const voluti = fin(concessioneTick) && concessioneTick > 0 ? Math.floor(concessioneTick) : 0;
  // ⚠ L'UNICO ARROTONDAMENTO DEL PAVIMENTO IN TUTTO IL REPO, e i due percorsi dell'uscita — quello in
  // banda e quello fuori banda — chiamano questo. Scriverlo una seconda volta in `exit-plan` sarebbe
  // il reperto D1 su un limite di rischio, ed è esattamente com'era nato: `planExit` arrotondava per
  // conto suo, ma SOLO dentro il ramo fuori banda, e il percorso in banda restava fuori griglia.
  const allaGriglia = (x) => +(Math.ceil(x / tick - 1e-9) * tick).toFixed(10);
  if (voluti <= 0) {
    // ⚠ ANCHE QUI, e non è un caso di scuola: il carico è un prezzo MEDIO di fill, quindi cade fuori
    // griglia più spesso di una frazione (un carico 0,6733 non è un prezzo). Il pavimento senza
    // concessione È il carico, quindi senza arrotondamento produce lo stesso `OFF_TICK`.
    return { pavimento: +carico.toFixed(10), pavimentoGriglia: allaGriglia(carico),
      tickConcessi: 0, limitatoDa: null,
      motivo: 'nessuna concessione: il pavimento è il carico' };
  }
  // ══ R7 · LA CONCESSIONE È IL 5% DEL CARICO, E BASTA — 18 agosto 2026, decisione dell'operatore ═══
  //
  // REGOLA: «Poi la scala d'uscita: fino al carico, dopo 60 minuti **fino al 5%**.»
  //
  // ⚠ COSA C'ERA PRIMA, E PERCHÉ CAMBIA. Il pavimento era `Math.max(daTick, daFrazione)`, cioè il più
  // STRETTO fra un tick e il 5%: su un token da 50¢ con tick 1¢ un tick è il 2%, quindi il 5% non
  // veniva mai raggiunto e il gradino 2 concedeva meno della metà di quello che la regola dichiara.
  // Il tick era stato scelto il 15 agosto come traduzione sulla griglia dei −0,89¢ mediani misurati
  // (§5-bis p.162) — una misura su CHI RIVENDE SUBITO, non su chi è scoperto da un'ora.
  //
  // ⚠ QUESTO ALLARGA UN LIMITE DI RISCHIO, ED È LA SOLA MODIFICA DI QUESTO GIRO CHE LO FA. Il tetto è
  // il 5% del carico della gamba scoperta: sul caso peggiore che questa configurazione può aprire —
  // una gamba che vale l'intero tetto per mercato, $61,25 — sono **$3,06**, contro i $0,63 di un tick
  // da 1¢ su 62,5 share. È una decisione dell'operatore, presa per iscritto, e resta scritta qui.
  //
  // ⚠ IL 5% NON È DIVENTATO UN OBIETTIVO: è un PAVIMENTO. Il prezzo lo sceglie il motore, che insegue
  // il miglior ask e si ferma qui solo se il libro sta più in basso (§4.6). Su un token economico il
  // 5% resta più stretto di un tick e la concessione si azzera sulla griglia: quel caso non cambia.
  const daFrazione = +(carico * (1 - PERDITA_MAX_FRAZIONE)).toFixed(10);
  const pavimento = daFrazione;
  // `limitatoDa` resta nel referto e adesso dice sempre `frazione`: il campo non è stato tolto perché
  // l'audit dei giorni scorsi lo contiene, e un campo che sparisce rende i due periodi non confrontabili.
  const limitatoDa = 'frazione';
  // I tick effettivamente concessi sulla griglia: può essere ZERO su un token economico, dove il 5%
  // non arriva a coprire un tick. Il numero onesto è questo, non `voluti`.
  const tickConcessi = Math.max(0, Math.floor(+((carico - pavimento) / tick).toFixed(6)));
  const pavimentoGriglia = allaGriglia(pavimento);
  return {
    pavimento, pavimentoGriglia, tickConcessi, limitatoDa,
    motivo: `pavimento $${pavimento.toFixed(4)}: il ${PERDITA_MAX_FRAZIONE * 100}% del carico ${carico}`
      + ` (${tickConcessi} tick sulla griglia da ${tick}, prezzo minimo esprimibile $${pavimentoGriglia.toFixed(4)})`
      + (tickConcessi === 0 ? ' — sulla griglia non copre nemmeno un tick: la concessione è di fatto nulla' : ''),
  };
}

/** Prove interne. Girano con `node lib/maker/urgenza-scoperto.js`. */
function selfcheck() {
  const ok = [];
  const A = (nome, cond) => ok.push({ nome, esito: !!cond });

  // ── LA SCALA ──────────────────────────────────────────────────────────────────────────────────
  // ⚠ LE SOGLIE SI LEGGONO DA `SOGLIE_MIN`, NON SI RICOPIANO. Un test che fotografa i numeri diventa
  // rosso ogni volta che l'operatore gira una manopola pur essendo il codice corretto — è la classe di
  // difetto di §5.3, alla quarta occorrenza. Qui si difende la FORMA della scala, non i suoi valori.
  A('sotto la soglia del pareggio il gradino è 0', livelloUrgenza({ scopertoDaMin: SOGLIE_MIN.pareggio - 1 }).livello === 0);
  A('alla soglia esatta scatta il pareggio', livelloUrgenza({ scopertoDaMin: SOGLIE_MIN.pareggio }).livello === 1);
  A('un minuto prima della peggiorativa si è ancora al pareggio', livelloUrgenza({ scopertoDaMin: SOGLIE_MIN.peggiorativa - 1 }).livello === 1);
  A('alla sua soglia si apre la peggiorativa', livelloUrgenza({ scopertoDaMin: SOGLIE_MIN.peggiorativa }).livello === 2);
  A('alla soglia dell anomalia il gradino è 3', livelloUrgenza({ scopertoDaMin: SOGLIE_MIN.anomalia }).livello === 3);
  A('le tre soglie sono in ordine stretto', SOGLIE_MIN.pareggio < SOGLIE_MIN.peggiorativa && SOGLIE_MIN.peggiorativa < SOGLIE_MIN.anomalia);
  A('il pareggio non concede tick', livelloUrgenza({ scopertoDaMin: SOGLIE_MIN.pareggio }).concessioneTick === 0);
  A('il caso reale (8,2h) è anomalia grave', livelloUrgenza({ scopertoDaMin: 492 }).anomaliaGrave === true);

  // ── LA MONOTONIA È LA PROPRIETÀ, NON I SINGOLI VALORI ────────────────────────────────────────
  let prevL = -1; let prevC = -1; let mono = true;
  for (let m = 0; m <= 600; m += 5) {
    const u = livelloUrgenza({ scopertoDaMin: m });
    if (u.livello < prevL || u.concessioneTick < prevC) mono = false;
    prevL = u.livello; prevC = u.concessioneTick;
  }
  A('la scala non torna mai indietro: livello e concessione sono monotoni', mono);

  // ── IL GRADINO 0 È ESATTAMENTE IL COMPORTAMENTO DI OGGI ──────────────────────────────────────
  const z = livelloUrgenza({ scopertoDaMin: 0 });
  A('a zero minuti: obiettivo +1% e nessuna concessione, cioè il comportamento di oggi',
    z.profitPct === 1 && z.concessioneTick === 0);
  // ⚠ NESSUN CAMPO DICHIARATO E NON CONSUMATO: è la regola che ha fatto cadere il gradino a 60 min.
  A('l\'esito non porta campi che nessuno legge',
    !Object.prototype.hasOwnProperty.call(z, 'riapriCopertura'));

  // ── TEMPO NON LEGGIBILE ⇒ NESSUNA CONCESSIONE ────────────────────────────────────────────────
  for (const v of [null, undefined, NaN, 'venti', -5]) {
    const u = livelloUrgenza({ scopertoDaMin: v });
    A(`tempo «${String(v)}» non concede niente`,
      u.livello === 0 && u.concessioneTick === 0 && u.profitPct === 1 && u.anomaliaGrave === false);
  }

  // ── IL PAVIMENTO — R7, 18 agosto 2026: LA CONCESSIONE È IL 5%, IL TICK NON LIMITA PIÙ ─────────
  // ⚠ SI ASSERISCE LA REGOLA, NON IL NUMERO: il pavimento si DERIVA da `PERDITA_MAX_FRAZIONE`, così
  // girare la manopola non produce un rosso su un codice corretto (§5.3).
  const p1 = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: CONCESSIONE_TICK_MAX });
  A('carico 0,43 tick 0,01: il pavimento è il 5% del carico, non un tick',
    Math.abs(p1.pavimento - 0.43 * (1 - PERDITA_MAX_FRAZIONE)) < 1e-9 && p1.limitatoDa === 'frazione');
  // ⚠ LA PROVA CHE LA REGOLA È CAMBIATA DAVVERO: a 0,43 un tick da 1¢ è il 2,33%, cioè MENO del 5%.
  // Col codice di prima il pavimento era 0,42; adesso è 0,4085 e concede 2 tick invece di 1.
  A('  e concede PIÙ di un tick dove prima il tick limitava',
    p1.tickConcessi > CONCESSIONE_TICK_MAX && p1.pavimento < 0.43 - CONCESSIONE_TICK_MAX * 0.01);
  // Dove la frazione era già quella che mordeva: su 10¢ un tick è il 10%, il 5% resta più stretto.
  const p2 = pavimentoConcesso({ carico: 0.10, tick: 0.01, concessioneTick: CONCESSIONE_TICK_MAX });
  A('carico 0,10: il 5% resta più stretto di un tick', p2.limitatoDa === 'frazione' && p2.pavimento > 0.09);
  A('e non concede mai oltre il 5%', p2.pavimento >= 0.10 * (1 - PERDITA_MAX_FRAZIONE) - 1e-12);
  // Nessuna concessione ⇒ il pavimento È il carico: il gradino 0 non può uscire in perdita.
  const p0 = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: 0 });
  A('senza concessione il pavimento è il carico', Math.abs(p0.pavimento - 0.43) < 1e-12 && p0.tickConcessi === 0);
  // ⚠ IL 5% È UN TETTO ASSOLUTO, e non si sfonda nemmeno chiedendo 99 tick: `concessioneTick` è il
  // cancello, non la quantità. Questa è la proprietà che sostituisce il vecchio clamp sui tick.
  const p9 = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: 99 });
  A('chiedere 99 tick non sfonda il 5%', Math.abs(p9.pavimento - p1.pavimento) < 1e-12);
  // ⚠ E IL PAVIMENTO NON SCENDE MAI SOTTO IL 5%, su tutta la scala dei prezzi quotabili.
  {
    let peggio = 0;
    for (let c = 3; c <= 97; c += 1) {
      const q = pavimentoConcesso({ carico: c / 100, tick: 0.01, concessioneTick: 99 });
      const perso = (c / 100 - q.pavimento) / (c / 100);
      if (perso > peggio) peggio = perso;
    }
    A(`su 95 carichi da 3¢ a 97¢ non si concede mai oltre il ${PERDITA_MAX_FRAZIONE * 100}% (peggiore ${(peggio * 100).toFixed(3)}%)`,
      peggio <= PERDITA_MAX_FRAZIONE + 1e-12);
  }
  // Ingressi illeggibili ⇒ niente.
  A('carico illeggibile ⇒ nessun pavimento', pavimentoConcesso({ carico: null, tick: 0.01, concessioneTick: 2 }).pavimento === null);
  A('tick illeggibile ⇒ nessun pavimento', pavimentoConcesso({ carico: 0.43, tick: null, concessioneTick: 2 }).pavimento === null);

  // ── LA PERDITA MASSIMA, MISURATA E NON PROMESSA — ricalcolata per R7 ─────────────────────────
  // ⚠ IL TETTO SI IMPORTA, NON SI RICOPIA: qui c'era $32,67 cablato, cioè il tetto per mercato di due
  // configurazioni fa. Adesso viene da `concentration`, e questa asserzione invecchia col tetto vero.
  // Il caso peggiore è una gamba che vale l'INTERO tetto per mercato: la perdita è allora esattamente
  // il 5% del tetto, qualunque sia il prezzo — la frazione non dipende dal carico.
  const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
  const share = MARKET_CAP_FIXED_USD / 0.43;
  const perdita = share * (0.43 - p1.pavimento);
  A(`la perdita massima sulla gamba più grande ($${MARKET_CAP_FIXED_USD}) è il ${PERDITA_MAX_FRAZIONE * 100}% = $${perdita.toFixed(2)}`,
    Math.abs(perdita - MARKET_CAP_FIXED_USD * PERDITA_MAX_FRAZIONE) < 0.01);
  // ⚠ E il caso vero di questa configurazione: sul mercato «1 Fed rate cut» (mid 0,095, tick 0,01) un
  // tick intero è il 10,5% del carico, quindi il belt del 5% taglia la concessione a ZERO. È il
  // comportamento voluto, ed è scritto qui perché non venga scoperto su capitale reale.
  const pFed = pavimentoConcesso({ carico: 0.095, tick: 0.01, concessioneTick: CONCESSIONE_TICK_MAX });
  A('su un token da 9,5¢ il belt del 5% azzera la concessione',
    pFed.tickConcessi === 0 && pFed.limitatoDa === 'frazione');

  const rossi = ok.filter((x) => !x.esito);
  for (const r of ok) console.log(`${r.esito ? '  ok' : 'FAIL'}  ${r.nome}`);
  console.log(`\n${ok.length - rossi.length}/${ok.length} verdi`);
  return rossi.length === 0;
}

module.exports = {
  livelloUrgenza, pavimentoConcesso, selfcheck,
  SOGLIE_MIN, CONCESSIONE_TICK_MAX, PERDITA_MAX_FRAZIONE, ETICHETTE,
};

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

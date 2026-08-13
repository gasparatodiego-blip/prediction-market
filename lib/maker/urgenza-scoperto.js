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
 *   · il tetto della coppia (99¢/120¢) e il pavimento di profondità non sono toccati.
 *
 * @module urgenza-scoperto
 */

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * LE SOGLIE, IN MINUTI. Si cambiano SOLO qui.
 *
 * 30  · q75 delle scoperture che si sono chiuse davvero (29,3 min): oltre questo punto pretendere
 *       ancora un GUADAGNO da una posizione che il mercato ha già superato è ciò che la tiene aperta.
 * 120 · mediana della popolazione che NON si chiude (126,5 min): da qui in poi si è nel regime
 *       patologico, e si accetta una perdita limitata pur di non restare direzionali.
 * 240 · nessuna scopertura ha mai superato le quattro ore ed è poi rientrata. È un guasto, e va gridato.
 *
 * ⚠ TRE SOGLIE E NON QUATTRO, E LA RAGIONE È UNA REGOLA DI QUESTO REPO. La prima stesura aveva un
 * gradino a 60 minuti che «non abbandonava la copertura a riposo» — e non serviva a niente: nel ramo
 * `no-target` il ciclo esce con `continue` PRIMA di arrivare alla cancellazione del completamento,
 * quindi quella copertura non veniva già cancellata. Era un gradino che dichiarava un'azione senza
 * consumarla da nessuna parte, cioè la classe di difetto «dep non cablata» vista dall'altro verso.
 * Un gradino che non apre una via non è un gradino: è una riga di documentazione travestita.
 */
const SOGLIE_MIN = Object.freeze({ pareggio: 30, peggiorativa: 120, anomalia: 240 });

/**
 * IL TETTO DI PERDITA DELLA CHIUSURA PEGGIORATIVA — dichiarato, e doppio.
 *
 * ⚠ PERCHÉ SI ACCETTA DI PERDERE QUALCOSA. L'alternativa a una chiusura peggiorativa **non è zero**:
 * è tenere un'esposizione direzionale il cui esito peggiore vale 100¢/share. È lo stesso ragionamento
 * con cui §4.6 accetta una coppia fino a 120¢ — lì si concedono fino a 20¢/share pur di non restare
 * direzionali, qui se ne concedono due. Questa è la concessione **più piccola** già in uso nel sistema.
 *
 * ⚠ DUE LIMITI, E IL PIÙ STRETTO VINCE.
 *   · `CONCESSIONE_TICK_MAX = 2` — in TICK e non in percentuale, perché il prezzo vive su una griglia:
 *     una concessione che non è esprimibile sulla griglia non è una concessione, è un arrotondamento.
 *   · `PERDITA_MAX_FRAZIONE = 0,05` — il 5% del carico. Serve dove il primo non basta: su un token da
 *     10¢ con tick 1¢, due tick sono il **20%**, e la stessa costante direbbe due cose diverse a
 *     seconda del prezzo. Sul carico di 43¢ del caso reale i due tick valgono il 4,65%, quindi passano;
 *     su un carico di 10¢ il clamp morde e la concessione scende a un tick.
 *
 * Costo massimo, misurato sulla posizione più grande che il bot possa aprire ($32,67 al tetto per
 * mercato): 2 tick su ~76 share = **$1,52**, cioè lo 0,23% del portafoglio di oggi. Contro
 * un'esposizione direzionale che, non chiusa, vale l'intero nozionale.
 */
const CONCESSIONE_TICK_MAX = 2;
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
 * @returns {{pavimento:number|null, tickConcessi:number, limitatoDa:string|null, motivo:string}}
 */
function pavimentoConcesso({ carico = null, tick = null, concessioneTick = 0 } = {}) {
  const no = (motivo) => ({ pavimento: null, tickConcessi: 0, limitatoDa: null, motivo });
  if (!fin(carico) || carico <= 0) return no('carico non leggibile: nessuna concessione');
  if (!fin(tick) || tick <= 0) return no('tick non leggibile: nessuna concessione');
  const voluti = fin(concessioneTick) && concessioneTick > 0
    ? Math.min(Math.floor(concessioneTick), CONCESSIONE_TICK_MAX) : 0;
  if (voluti <= 0) {
    return { pavimento: +carico.toFixed(10), tickConcessi: 0, limitatoDa: null,
      motivo: 'nessuna concessione: il pavimento è il carico' };
  }
  // Il più stretto dei due limiti vince — e si dichiara QUALE, perché «2 tick» e «5%» danno risposte
  // diverse a prezzi diversi e chi legge l'audit deve sapere quale ha morso.
  const daTick = +(carico - voluti * tick).toFixed(10);
  const daFrazione = +(carico * (1 - PERDITA_MAX_FRAZIONE)).toFixed(10);
  const pavimento = Math.max(daTick, daFrazione);
  const limitatoDa = pavimento === daFrazione && daFrazione > daTick ? 'frazione' : 'tick';
  // I tick effettivamente concessi dopo il clamp: può essere meno di `voluti`, e il numero onesto è questo.
  const tickConcessi = Math.max(0, Math.floor(+((carico - pavimento) / tick).toFixed(6)));
  return {
    pavimento, tickConcessi, limitatoDa,
    motivo: limitatoDa === 'frazione'
      ? `pavimento $${pavimento.toFixed(4)}: ${voluti} tick sarebbero oltre il ${PERDITA_MAX_FRAZIONE * 100}% del carico ${carico}, quindi vale il limite di frazione`
      : `pavimento $${pavimento.toFixed(4)}: ${tickConcessi} tick sotto il carico ${carico}`,
  };
}

/** Prove interne. Girano con `node lib/maker/urgenza-scoperto.js`. */
function selfcheck() {
  const ok = [];
  const A = (nome, cond) => ok.push({ nome, esito: !!cond });

  // ── LA SCALA ──────────────────────────────────────────────────────────────────────────────────
  A('sotto i 30 min il gradino è 0', livelloUrgenza({ scopertoDaMin: 29 }).livello === 0);
  A('a 30 min esatti scatta il pareggio', livelloUrgenza({ scopertoDaMin: 30 }).livello === 1);
  A('a 119 min si è ancora al pareggio', livelloUrgenza({ scopertoDaMin: 119 }).livello === 1);
  A('a 120 min si apre la peggiorativa', livelloUrgenza({ scopertoDaMin: 120 }).livello === 2);
  A('a 240 min è anomalia grave', livelloUrgenza({ scopertoDaMin: 240 }).livello === 3);
  A('il pareggio non concede tick', livelloUrgenza({ scopertoDaMin: 60 }).concessioneTick === 0);
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

  // ── IL PAVIMENTO ──────────────────────────────────────────────────────────────────────────────
  // Il caso reale: carico 0,43 · tick 0,01 · 2 tick = 4,65%, sotto il 5% ⇒ passa per intero.
  const p1 = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: 2 });
  A('carico 0,43 tick 0,01: pavimento 0,41 e limita il tick', Math.abs(p1.pavimento - 0.41) < 1e-9 && p1.limitatoDa === 'tick');
  // Dove il clamp deve mordere: su 10¢ due tick sono il 20%.
  const p2 = pavimentoConcesso({ carico: 0.10, tick: 0.01, concessioneTick: 2 });
  A('carico 0,10: il limite di frazione morde', p2.limitatoDa === 'frazione' && p2.pavimento > 0.09);
  A('e non concede mai oltre il 5%', p2.pavimento >= 0.10 * (1 - PERDITA_MAX_FRAZIONE) - 1e-12);
  // Nessuna concessione ⇒ il pavimento È il carico: il gradino 0 non può uscire in perdita.
  const p0 = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: 0 });
  A('senza concessione il pavimento è il carico', Math.abs(p0.pavimento - 0.43) < 1e-12 && p0.tickConcessi === 0);
  // Il tetto assoluto in tick non si supera nemmeno chiedendolo.
  const p9 = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: 99 });
  A('non si concedono mai più di CONCESSIONE_TICK_MAX tick', p9.tickConcessi <= CONCESSIONE_TICK_MAX);
  // Ingressi illeggibili ⇒ niente.
  A('carico illeggibile ⇒ nessun pavimento', pavimentoConcesso({ carico: null, tick: 0.01, concessioneTick: 2 }).pavimento === null);
  A('tick illeggibile ⇒ nessun pavimento', pavimentoConcesso({ carico: 0.43, tick: null, concessioneTick: 2 }).pavimento === null);

  // ── LA PERDITA MASSIMA È DAVVERO PICCOLA, e il test la misura invece di prometterla ──────────
  // Posizione più grande apribile: tetto per mercato $32,67 su un carico di 0,43 ⇒ ~76 share.
  const share = 32.67 / 0.43;
  const perdita = share * (0.43 - p1.pavimento);
  A('la perdita massima sulla posizione più grande resta sotto $2', perdita < 2);

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

'use strict';
// lib/maker/utilizzo-capitale.js — QUANTO DEL CAPITALE STA DAVVERO LAVORANDO.
//
// ═══ PERCHE' ESISTE ══════════════════════════════════════════════════════════════════════════════════
// Il bot ha sempre avuto tetti — 20% per mercato, 12% sulla coda lunga, un muro a 150 giorni — cioe' un
// insieme di regole che dicono DOVE NON mettere il capitale. Non ha mai avuto la regola simmetrica: che
// il capitale, di norma, debba stare al lavoro. Il risultato e' un sistema che non sbaglia mai per
// eccesso e sbaglia sistematicamente per difetto, senza che nessun numero lo dichiari. L'8 agosto 2026
// il conto e' rimasto con centinaia di dollari liquidi per ore senza che una sola riga di log lo
// chiamasse un problema: nessuna soglia era stata superata, perche' non ne esisteva una.
//
// Questo modulo introduce quella soglia e — soprattutto — la rende un NUMERO che si legge, non un
// obiettivo dichiarato a parole.
//
// ═══ COSA CONTA COME «IMPEGNATO» ════════════════════════════════════════════════════════════════════
// Due cose, e nessuna delle due e' opinabile:
//   · gli ORDINI A RIPOSO, al loro nozionale. Su questo venue un BUY a riposo immobilizza il
//     collaterale: quei dollari non sono nel saldo, quindi contarli qui non li conta due volte.
//   · le POSIZIONI APERTE, al prezzo corrente del venue. Sono capitale impiegato quanto un ordine: la
//     differenza e' che maturano il risultato invece del premio.
// E «totale» = liquido + impegnato. Il liquido e' il saldo pUSD, per la stessa identita': cio' che non
// e' immobilizzato da un ordine ne' trasformato in posizione sta nel saldo.
//
// ═══ IL TARGET NON E' UN COMANDO, E' UN METRO ═══════════════════════════════════════════════════════
// 90% non autorizza niente. Non alza un tetto, non salta un controllo, non rende ammissibile un mercato
// che non lo era. Tutte le protezioni esistenti restano davanti a questo numero e vincono su di esso:
// se i mercati validi non bastano a raggiungere il 90%, il verdetto giusto e' «non raggiunto perche' non
// c'era dove metterlo», che e' un'informazione, non un fallimento da correggere forzando un ordine.
// Per questo `misuraUtilizzo` non decide NIENTE: misura, e chi legge decide.
//
// ═══ LEGGIBILE O NIENTE ═════════════════════════════════════════════════════════════════════════════
// Un ingresso non leggibile non diventa zero. Un saldo illeggibile trattato come 0 farebbe risultare
// l'utilizzo al 100% — cioe' il difetto peggiore possibile in un modulo che esiste per accorgersi che il
// capitale e' fermo. Quindi: qualunque ingresso mancante ⇒ `leggibile:false` e nessuna percentuale.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * L'OBIETTIVO. 90% del capitale totale impegnato in condizioni normali.
 *
 * Perche' 90 e non 100: un conto al 100% non ha di che pagare il prossimo ordine, e su questo venue il
 * capitale si libera a scatti (un fill, una risoluzione) mentre si impegna in modo continuo. Il 10% di
 * respiro e' circa $60-80 su questo conto, cioe' due ordini del nozionale mediano dei 21 maker di
 * riferimento (~$34): abbastanza perche' il trigger a capitale fermo abbia sempre di che lavorare senza
 * dover prima disfare qualcosa.
 *
 * Si cambia con MAKER_TARGET_UTILIZZO (frazione, non percentuale). Un valore illeggibile o fuori da
 * (0,1] viene SCARTATO in favore del difetto: la stessa regola di fine scala e dell'orizzonte — un
 * `.env` sbagliato non deve poter spegnere ne' snaturare una misura.
 */
function leggiTarget(env = process.env) {
  const v = Number(env.MAKER_TARGET_UTILIZZO);
  return fin(v) && v > 0 && v <= 1 ? v : 0.90;
}
const TARGET_UTILIZZO = leggiTarget();

/**
 * LA MISURA. Pura: nessuna lettura, nessuna rete. Gli ingressi arrivano gia' letti da chi la chiama.
 *
 * @param {object} a
 *   saldoUsd            il pUSD liquido (null/NaN ⇒ non leggibile)
 *   ordiniARiposoUsd    il nozionale degli ordini a riposo (null ⇒ non leggibile)
 *   posizioniUsd        il valore delle posizioni aperte al prezzo corrente (null ⇒ non leggibile)
 *   target              la frazione obiettivo; di difetto TARGET_UTILIZZO
 *   motivoDeficit       (opzionale) perche' il target non e' raggiunto, se chi chiama lo sa
 * @returns {{leggibile:boolean, motivo:string, capitaleTotaleUsd:number|null, impegnatoUsd:number|null,
 *            liberoUsd:number|null, frazione:number|null, pct:number|null, target:number, targetPct:number,
 *            raggiunto:boolean|null, deficitUsd:number|null}}
 */
function misuraUtilizzo({
  saldoUsd = null, ordiniARiposoUsd = null, posizioniUsd = null,
  target = TARGET_UTILIZZO, motivoDeficit = null,
} = {}) {
  const t = fin(target) && target > 0 && target <= 1 ? target : TARGET_UTILIZZO;
  const vuoto = (motivo) => ({
    leggibile: false, motivo,
    capitaleTotaleUsd: null, impegnatoUsd: null, liberoUsd: null,
    frazione: null, pct: null, target: t, targetPct: +(t * 100).toFixed(1),
    raggiunto: null, deficitUsd: null,
  });

  // I tre ingressi si controllano UNO PER UNO e il motivo dice quale manca: «non lo so» è utile solo se
  // dice cosa non si sa. Un totale che tace su quale pezzo mancava manda a cercare nel posto sbagliato.
  if (!fin(saldoUsd) || saldoUsd < 0) return vuoto('saldo pUSD non leggibile: senza il liquido non esiste un totale, e un saldo trattato come zero direbbe «utilizzo 100%» proprio quando il capitale è fermo');
  if (!fin(ordiniARiposoUsd) || ordiniARiposoUsd < 0) return vuoto('nozionale degli ordini a riposo non leggibile: l\'impegnato resta sconosciuto');
  if (!fin(posizioniUsd) || posizioniUsd < 0) return vuoto('valore delle posizioni aperte non leggibile: l\'impegnato resta sconosciuto');

  // ── IL DOPPIO CONTEGGIO, E PERCHÉ ERA UN BUG DI SICUREZZA OPERATIVA ──────────────────────────────
  // Fino al 9 agosto 2026 qui c'era `totale = saldo + ordiniARiposo + posizioni`, cioè le tre fonti
  // sommate come indipendenti. Non lo sono, e non lo sono MAI:
  //   · un BUY a riposo è coperto dal CASH — su questo venue l'ordine è firmato off-chain e il
  //     collaterale resta nel wallet fino al match, quindi quei dollari sono già dentro il saldo;
  //   · un SELL a riposo è coperto dai TOKEN, cioè dalla posizione — già dentro `posizioniUsd`.
  // In entrambi i casi `ordiniARiposoUsd` è un SOTTOINSIEME di `saldo + posizioni`, mai un addendo.
  //
  // MISURATO il 9 agosto 2026, con lettura on-chain: cash $633,90 + posizioni $35,19 = **$669,09**,
  // esattamente il Portfolio dell'app Polymarket. Il referto dichiarava **$776,65** — gonfiato di
  // $107,46, il nozionale a riposo, cioè **+16,1%**.
  //
  // NON ERA UN ERRORE ESTETICO. `liberoUsd` riportava il saldo PIENO come se fosse tutto disponibile,
  // mentre una parte era già promessa a ordini sul libro; e il trigger a capitale fermo decide su quel
  // numero quanto impegnare. Un totale gonfiato allarga anche il tetto di concentrazione, che è il 20%
  // del totale: il 9 agosto valeva $155,33 invece di $133,82, cioè un limite di RISCHIO più largo del
  // dichiarato.
  const totale = +(saldoUsd + posizioniUsd).toFixed(4);

  // ── IL LIBERO VERO: IL CASH CHE NON STA GIÀ COPRENDO UN ORDINE ──────────────────────────────────
  // Si sottrae l'INTERO nozionale a riposo dal cash, anche se la parte SELL è coperta dai token e non
  // dal cash. È deliberatamente CONSERVATIVO: senza la scomposizione per lato non si può separare i due
  // (`nozionaleARiposo` somma prezzo × size su tutti gli ordini), e sbagliare in difetto qui vuol dire
  // piazzare MENO, che è il verso sicuro. Se un giorno il chiamante saprà distinguere BUY da SELL, la
  // stima si stringe; fino ad allora è meglio un libero sottostimato che uno promesso due volte.
  const libero = +Math.max(0, saldoUsd - ordiniARiposoUsd).toFixed(4);
  // Tutto ciò che non è liquido e libero sta lavorando: le posizioni, più il cash che copre i BUY a
  // riposo. Derivato dal totale invece che sommato a parte, così le due misure non possono divergere.
  const impegnato = +(totale - libero).toFixed(4);
  if (!(totale > 0)) {
    return { ...vuoto('capitale totale a zero: non c\'è niente da impegnare, e una percentuale su zero non significa niente'), leggibile: false };
  }
  const frazione = +(impegnato / totale).toFixed(6);
  // Il deficit e' in DOLLARI e non in punti percentuali, perche' e' la sola forma in cui la misura si
  // traduce in un'azione: «mancano $84 al lavoro» dice quanto ordine serve, «mancano 13 punti» no.
  const deficit = +Math.max(0, totale * t - impegnato).toFixed(2);
  const raggiunto = frazione + 1e-9 >= t;

  return {
    leggibile: true,
    capitaleTotaleUsd: totale,
    impegnatoUsd: impegnato,
    // Il libero VERO, non il saldo pieno: chi legge questo campo decide quanto impegnare, e prima del
    // 9 agosto 2026 gli veniva promesso anche il cash che copriva già gli ordini a riposo.
    liberoUsd: libero,
    // Il saldo grezzo resta leggibile accanto, perché «quanto ho in cassa» e «quanto posso impegnare»
    // sono due domande diverse e confonderle è esattamente il difetto che questo fix chiude.
    saldoUsd: +saldoUsd.toFixed(4),
    ordiniARiposoUsd: +ordiniARiposoUsd.toFixed(4),
    frazione,
    pct: +(frazione * 100).toFixed(1),
    target: t,
    targetPct: +(t * 100).toFixed(1),
    raggiunto,
    deficitUsd: deficit,
    motivo: raggiunto
      ? `utilizzo ${(frazione * 100).toFixed(1)}% ≥ obiettivo ${(t * 100).toFixed(0)}%: $${impegnato.toFixed(2)} al lavoro su $${totale.toFixed(2)}`
      : `utilizzo ${(frazione * 100).toFixed(1)}% sotto l'obiettivo ${(t * 100).toFixed(0)}%: mancano $${deficit.toFixed(2)} da mettere al lavoro`
        + (motivoDeficit ? ` — ${motivoDeficit}` : ''),
  };
}

/** Una riga sola per il log e per l'audit. Non leggibile ⇒ lo dice, non inventa un numero. */
function formattaUtilizzo(u) {
  if (!u || u.leggibile !== true) return `utilizzo capitale: NON MISURABILE (${(u && u.motivo) || 'nessuna misura'})`;
  return `utilizzo capitale ${u.pct}% (obiettivo ${u.targetPct}%) · $${u.impegnatoUsd.toFixed(2)} al lavoro`
    + ` / $${u.capitaleTotaleUsd.toFixed(2)} totali · liberi $${u.liberoUsd.toFixed(2)}`
    + (u.raggiunto ? '' : ` · deficit $${u.deficitUsd.toFixed(2)}`);
}

/** Il nozionale a riposo da una lista di ordini del venue. Stessa aritmetica di trigger-capitale-fermo. */
function nozionaleARiposo(ordini) {
  if (!Array.isArray(ordini)) return null;
  let tot = 0;
  for (const o of ordini) {
    const p = Number(o && o.price);
    const s = Number(o && (o.sizeRemaining != null ? o.sizeRemaining : o.size));
    // Un ordine con prezzo o size illeggibili renderebbe il totale una sottostima silenziosa. Meglio
    // dichiarare l'intero totale non leggibile: e' l'ingresso di una misura, non una statistica.
    if (!fin(p) || p <= 0 || !fin(s) || s <= 0) return null;
    tot += p * s;
  }
  return +tot.toFixed(4);
}

/** Il valore delle posizioni aperte al prezzo corrente del venue. Un prezzo assente rende tutto ignoto. */
function valorePosizioni(posizioni) {
  if (!Array.isArray(posizioni)) return null;
  let tot = 0;
  for (const p of posizioni) {
    const size = Math.abs(Number(p && p.size));
    const prezzo = Number(p && (p.curPrice != null ? p.curPrice : p.avgPrice));
    if (!fin(size) || size <= 0) continue;          // una size nulla non e' una posizione
    if (!fin(prezzo) || prezzo <= 0) return null;   // una posizione senza prezzo rende il totale ignoto
    tot += size * prezzo;
  }
  return +tot.toFixed(4);
}

// ═══ QUANTI MERCATI NUOVI, ADESSO ═══════════════════════════════════════════════════════════════════
// Ha sostituito il 9 agosto 2026 la RAMPA (5 mercati nuovi ogni 24h dall'AVVIA — vedi bot-enabled.js).
//
// Perche' il tetto giornaliero era la forma sbagliata, misurato l'8-9 agosto: i cinque posti si sono
// consumati in 32 minuti, gli ordini sono poi stati cancellati o riempiti, e il conto e' rimasto a
// utilizzo 3,9% con $644 liquidi mentre il tetto restava chiuso per altre 18 ore. Un contatore
// giornaliero conta le APERTURE; quello che conta e' il CAPITALE ESPOSTO, e i due numeri divergono
// esattamente nel caso che interessa — mercati aperti e richiusi in fretta.
//
// La regola nuova non ha memoria e non ha calendario: si aprono mercati nuovi finche' l'utilizzo sta
// sotto l'obiettivo, mai piu' di `MAX_NUOVI_PER_GIRO` in un solo giro. Si chiude da se' quando il
// capitale e' al lavoro, si riapre da se' quando torna libero.
//
// ═══ PERCHE' RESTA UN LIMITE PER GIRO, INVECE DI NESSUN LIMITE ══════════════════════════════════════
// Perche' i due limiti rispondono a domande diverse. Il target dice QUANTO capitale impegnare, e il
// limite per giro dice quanto in FRETTA. Senza il secondo, un solo giro potrebbe aprire tutte le righe
// del piano insieme: non violerebbe nessuna regola di rischio — tutte quelle per-mercato stanno a valle
// e restano intatte — ma renderebbe un singolo errore di piano (un board vecchio, una stima gonfia) un
// errore su tutto il conto in una volta, senza che nessuno abbia avuto un giro per accorgersene.
//
// E c'e' un fatto che vale la pena dire chiaro: nel regime stazionario questo e' PIU' STRETTO di prima.
// La rampa dava Infinity — nessun limite di alcun tipo — passate le 24h dall'AVVIA. Questo non da' mai
// Infinity: il tetto per giro vale sempre, dal primo minuto e per sempre.
//
// 6 e non altro: e' lo stesso numero di `TRIGGER_CAPITALE_MAX_MERCATI` (il raggio d'azione di un
// mini-ciclo) e sta appena sopra le sette righe del piano tipico su questo conto, quindi non e' mai il
// vincolo che morde per primo — a mordere restano lo spazio sotto il tetto del 20% e il minimo d'ordine.
function leggiMaxNuoviPerGiro(env = process.env) {
  const v = Number(env.MAKER_MAX_NUOVI_PER_GIRO);
  return fin(v) && v >= 1 ? Math.floor(v) : 6;
}
const MAX_NUOVI_PER_GIRO = leggiMaxNuoviPerGiro();

/**
 * Quanti mercati NUOVI questo giro puo' aprire. Puro: nessuna lettura, nessun file, nessuna memoria.
 *
 * @param utilizzo    l'esito di `misuraUtilizzo`. Non leggibile ⇒ NON blocca: resta il solo tetto per
 *                    giro. La ragione e' che il gate del capitale sta gia' a monte — un mini-ciclo non
 *                    arriva qui senza un saldo letto — e un secondo blocco su un dato mancante
 *                    riprodurrebbe la paralisi che questa funzione esiste per togliere.
 * @param maxPerGiro  il tetto di velocita'; valori assurdi vengono scartati in favore del difetto.
 * @returns {{ammessi:number, tetto:number, motivo:string}} `ammessi` non e' mai Infinity.
 */
function aperturaNuoviMercati({ utilizzo = null, maxPerGiro = MAX_NUOVI_PER_GIRO } = {}) {
  const tetto = fin(maxPerGiro) && maxPerGiro >= 1 ? Math.floor(maxPerGiro) : MAX_NUOVI_PER_GIRO;
  const misurato = utilizzo && utilizzo.leggibile === true;
  if (misurato && utilizzo.raggiunto === true) {
    // Non e' un divieto di operare: il giro puo' ancora RIBILANCIARE i mercati gia' aperti. E' che
    // aprirne uno nuovo non serve a un obiettivo gia' raggiunto, e ogni mercato in piu' e' un rischio
    // di risoluzione in piu' a parita' di capitale al lavoro.
    return { ammessi: 0, tetto,
      motivo: `obiettivo di utilizzo raggiunto (${utilizzo.pct}% ≥ ${utilizzo.targetPct}%): un mercato NUOVO non aggiungerebbe capitale al lavoro` };
  }
  return {
    ammessi: tetto, tetto,
    motivo: misurato
      ? `utilizzo ${utilizzo.pct}% sotto l'obiettivo ${utilizzo.targetPct}% (mancano $${utilizzo.deficitUsd.toFixed(2)}): fino a ${tetto} mercati nuovi in questo giro`
      : `utilizzo non misurabile (${(utilizzo && utilizzo.motivo) || 'nessuna misura'}): resta il solo tetto di ${tetto} mercati nuovi per giro`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LA RICONCILIAZIONE, E PERCHÉ SERVE — 12 agosto 2026
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Il mini-ciclo delle 13:07 ha misurato, NELLO STESSO GIRO, «capitale liquido fermo $663,11» e
// «$273,11 al lavoro / $273,11 totali · liberi $0,00». Le due letture si contraddicevano, e la
// seconda era sbagliata: era `misuraUtilizzo` chiamata una seconda volta con
// `saldoUsd: max(0, saldo − impegnato)` E `ordiniARiposoUsd: aRiposo + impegnato`, cioè lo stesso
// $390 sottratto dal saldo E aggiunto agli ordini. Contato due volte.
//
// È lo stesso doppio conteggio che §5 punto 58 aveva tolto dal primo passo e che era rimasto nel
// secondo: **su questo venue un BUY a riposo tiene il collaterale nel wallet fino al match**, quindi
// piazzare NON abbassa il saldo. Riprodotto coi numeri veri (saldo 663,11 · impegnato 390 · pos 0):
//   com'era     → totale $273,11 · libero $0     · impegnato $273,11 · 100%   ← la riga di log
//   corretto    → totale $663,11 · libero $273,11 · impegnato $390    · 58,8%
//
// `misuraDopo` esiste per rendere impossibile rifare quell'errore: il saldo NON è un suo parametro.

/** Oltre questi, due letture dello stesso capitale non descrivono lo stesso conto. */
const RICONCILIA_FRAC = 0.02;   // 2%
const RICONCILIA_USD = 5;       // e comunque mai meno di $5, per non inciampare sugli arrotondamenti

/**
 * Due letture dello stesso capitale sono la stessa cosa?
 *
 * NON è una formalità: finché le misure erano due e nessuno le confrontava, una poteva essere
 * assurda senza che niente lo dicesse. Oltre soglia il chiamante deve FERMARE il giro — agire su un
 * capitale che non si sa quanto sia è il modo di impegnare denaro già impegnato altrove.
 *
 * @returns {{concorde:boolean, scartoUsd:number|null, scartoFrac:number|null, sogliaUsd:number, motivo:string}}
 */
function riconcilia({ a, b, etichettaA = 'lettura A', etichettaB = 'lettura B', frac = RICONCILIA_FRAC, usd = RICONCILIA_USD } = {}) {
  const finito = (x) => typeof x === 'number' && Number.isFinite(x);
  if (!finito(a) || !finito(b)) {
    // Fail-closed: una lettura mancante NON è una lettura concorde.
    return { concorde: false, scartoUsd: null, scartoFrac: null, sogliaUsd: usd,
      motivo: `capitale non confrontabile: ${etichettaA}=${finito(a) ? a : 'non leggibile'}, ${etichettaB}=${finito(b) ? b : 'non leggibile'}` };
  }
  const scarto = Math.abs(a - b);
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  const soglia = Math.max(usd, base * frac);
  const concorde = scarto <= soglia;
  return {
    concorde,
    scartoUsd: +scarto.toFixed(4),
    scartoFrac: +(scarto / base).toFixed(6),
    sogliaUsd: +soglia.toFixed(2),
    motivo: concorde
      ? `${etichettaA} $${a.toFixed(2)} e ${etichettaB} $${b.toFixed(2)} concordano (scarto $${scarto.toFixed(2)} ≤ $${soglia.toFixed(2)})`
      : `LE DUE LETTURE DEL CAPITALE NON CONCORDANO: ${etichettaA} $${a.toFixed(2)} contro ${etichettaB} $${b.toFixed(2)}`
        + ` — scarto $${scarto.toFixed(2)} oltre la soglia di $${soglia.toFixed(2)}. Non si agisce su un capitale che non si sa quanto sia.`,
  };
}

/**
 * L'utilizzo DOPO che il giro ha impegnato del capitale.
 *
 * Il saldo NON è un parametro, ed è tutto il punto: chi chiama non può più sottrarlo. L'unico effetto
 * di un piazzamento è che il nozionale a riposo cresce; il saldo si muoverà quando il venue eseguirà,
 * e a quel punto lo dirà il giro dopo leggendolo di nuovo.
 */
function misuraDopo(misuraPrima, impegnatoOraUsd, extra = {}) {
  const imp = (typeof impegnatoOraUsd === 'number' && Number.isFinite(impegnatoOraUsd)) ? impegnatoOraUsd : 0;
  if (!misuraPrima || misuraPrima.leggibile !== true) {
    return { ...(misuraPrima || {}), leggibile: false, motivo: 'misura di partenza non leggibile: nessuna stima del dopo' };
  }
  // Il valore delle posizioni non viaggia nel risultato di `misuraUtilizzo`, ma è ricavabile dal suo
  // stesso invariante — `totale = saldo + posizioni` — quindi non serve richiederlo al chiamante né
  // rileggerlo: due letture delle posizioni nello stesso giro potrebbero divergere, ed è proprio la
  // classe di difetto che questo modulo esiste per chiudere.
  const posizioni = +(misuraPrima.capitaleTotaleUsd - misuraPrima.saldoUsd).toFixed(4);
  return misuraUtilizzo({
    saldoUsd: misuraPrima.saldoUsd,                                   // INVARIATO, per costruzione
    ordiniARiposoUsd: +((misuraPrima.ordiniARiposoUsd || 0) + imp).toFixed(4),
    posizioniUsd: Number.isFinite(posizioni) ? posizioni : null,
    ...extra,
  });
}

module.exports = {
  misuraUtilizzo, formattaUtilizzo, nozionaleARiposo, valorePosizioni,
  leggiTarget, TARGET_UTILIZZO,
  aperturaNuoviMercati, leggiMaxNuoviPerGiro, MAX_NUOVI_PER_GIRO,
  riconcilia, misuraDopo, RICONCILIA_FRAC, RICONCILIA_USD,
};

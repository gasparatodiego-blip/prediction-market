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

  const impegnato = +(ordiniARiposoUsd + posizioniUsd).toFixed(4);
  const totale = +(saldoUsd + impegnato).toFixed(4);
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
    liberoUsd: +saldoUsd.toFixed(4),
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

module.exports = {
  misuraUtilizzo, formattaUtilizzo, nozionaleARiposo, valorePosizioni,
  leggiTarget, TARGET_UTILIZZO,
};

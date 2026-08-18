'use strict';
// lib/maker/sblocco-residuo.js — COMPRARE L'ALTRO LATO PER SBLOCCARE UN RESIDUO, ANCHE OLTRE 101¢.
// Aritmetica PURA: nessun `fs`, nessuna rete, nessun venue, nessun `require`.
//
// ═══ LA REGOLA (R6, seconda metà — decisa dall'operatore il 18 agosto 2026) ══════════════════════════
// «Tetto in DOLLARI, non in centesimi per share: spendi al massimo quanto vale la posizione residua, e
//  comunque mai più di $5 per sbloccarla. Se nemmeno così si chiude, dichiara e lascia stare:
//  aspetteremo la risoluzione.»
//
// ═══ IL PROBLEMA ════════════════════════════════════════════════════════════════════════════════════
// Un residuo sotto `min_incentive_size` è capitale che nessun ordine di libro può muovere: il venue
// rifiuta la size. La prima metà di R6 gli ha dato una via — vendere attraversando, con la deroga
// `BELOW_MIN_SIZE` sulle chiusure (§4.6). Ma quella via **si può chiudere**: se il bid non è leggibile,
// o il ricavo sarebbe nullo, la gamba resta.
//
// Resta allora la via che **non passa dal libro**: comprare l'altro lato per la stessa quantità e
// **fondere**. Il merge on-chain non ha minimi di size, quindi una coppia da 6 share vale $6 alla
// risoluzione tanto quanto una da 600. Il problema è che comprare l'altro lato di un residuo costa
// spesso **più di quanto la coppia renderà**: se il residuo è costato 50¢ e l'altro lato ne chiede 60,
// la coppia costa 110¢ per rendere 100¢. Il tetto di 101¢ di §4.6 esiste per rifiutare esattamente
// questo — ed è giusto **quando si sta aprendo**.
//
// ⚠ MA QUI NON SI STA APRENDO: SI STA SBLOCCANDO. La domanda non è «questa coppia è profittevole?» —
// non lo è, e l'operatore lo sa. È «pagare questa perdita conviene più che lasciare il capitale fermo
// fino alla risoluzione?». È una domanda diversa, e l'operatore le ha dato due tetti.
//
// ═══ I DUE TETTI, E PERCHÉ SONO DUE ═════════════════════════════════════════════════════════════════
//   ① **la spesa non supera il valore della posizione residua.** Spendere $8 per sbloccare $3 è
//      distruggere capitale per far tornare un conto. Il valore è `size × prezzo corrente`.
//   ② **e comunque mai più di $5.** Il primo tetto scala col residuo, e un residuo grande potrebbe
//      giustificare una spesa grande — ma R6 nasce per i residui **piccoli**, quelli che nessuna altra
//      via può chiudere. $5 è il tetto assoluto che impedisce a questa via di diventare un canale.
//
// ⚠ IL TETTO È IN DOLLARI, NON IN CENTESIMI PER SHARE, ed è una scelta esplicita dell'operatore. Un
// tetto per share (come i 101¢) su un residuo di 6 share e su uno di 600 autorizza due spese
// completamente diverse a parità di «quanto sopra la pari». In dollari, il limite è quello che conta:
// quanto esce dal conto.
//
// ⚠ SE NESSUNO DEI DUE BASTA, NON SI COMPRA E LO SI DICHIARA. «Aspetteremo la risoluzione» non è una
// resa: una gamba nuda tenuta fino alla risoluzione vale 0 o 1 per share, e il costo è il TEMPO, non
// il capitale (§5-bis p.187). Comprare oltre i tetti trasformerebbe un costo di tempo in una perdita
// certa.
//
// ═══ COSA QUESTO MODULO NON FA ══════════════════════════════════════════════════════════════════════
// Non compra e non fonde: dice **se** si può comprare, **quanto** si può spendere e **a che prezzo
// medio massimo**. Chi lo cabla usa i percorsi che esistono già — la corsia manuale per il BUY,
// `auto-close.fondiCoppia` per il merge. Nessuna strada nuova verso il venue.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Il tetto assoluto in dollari, deciso dall'operatore. Non è una manopola e non ha un env: è la cosa
 *  che impedisce a questa via di diventare un canale di acquisto sopra la pari. */
const SPESA_MASSIMA_USD = 5;

/**
 * SI PUÒ SBLOCCARE QUESTO RESIDUO COMPRANDO L'ALTRO LATO?
 *
 * @param {object}   a
 * @param {number}   a.sizeResidua      le share del lato che possediamo e non riusciamo a chiudere
 * @param {number}   a.prezzoCorrente   il prezzo corrente del NOSTRO lato (per il valore della posizione)
 * @param {Array?}   a.asksAltroLato    la scala degli ask dell'altro lato: `[{price, size}, …]`
 * @param {number?}  a.spesaMassimaUsd  il tetto assoluto; di difetto `SPESA_MASSIMA_USD`
 * @returns {{sblocca:boolean, size:number, costoUsd:number|null, prezzoMedio:number|null,
 *            prezzoPeggiore:number|null, valoreResiduoUsd:number|null, tetto:number|null,
 *            limitatoDa:('valore'|'assoluto'|null), motivo:string}}
 */
function valutaSblocco({ sizeResidua = null, prezzoCorrente = null, asksAltroLato = null,
  spesaMassimaUsd = SPESA_MASSIMA_USD } = {}) {
  const no = (motivo, extra = {}) => ({ sblocca: false, size: 0, costoUsd: null, prezzoMedio: null,
    prezzoPeggiore: null, valoreResiduoUsd: null, tetto: null, limitatoDa: null, motivo, ...extra });

  if (!fin(sizeResidua) || sizeResidua <= 0) return no('nessun residuo da sbloccare');

  // ⚠ IL VALORE DELLA POSIZIONE È IL PRIMO TETTO, E SENZA NON SI COMPRA. «Non ho letto il prezzo» non
  // può diventare «spendi fino al tetto assoluto»: sarebbe `Number(null) === 0` al contrario, cioè
  // un'assenza che autorizza. Fail-closed.
  if (!fin(prezzoCorrente) || prezzoCorrente <= 0) {
    return no('prezzo corrente del residuo non leggibile: senza il suo valore non si sa quanto si può'
      + ' spendere, e non si compra al buio');
  }
  const valoreResiduoUsd = +(sizeResidua * prezzoCorrente).toFixed(6);

  // ⚠ IL PIÙ STRETTO DEI DUE TETTI VINCE, e si dichiara QUALE: «$3 perché la posizione vale $3» e «$5
  // perché è il massimo assoluto» sono due fatti diversi, e chi legge l'audit deve poterli distinguere.
  const tettoAssoluto = fin(spesaMassimaUsd) && spesaMassimaUsd > 0 ? spesaMassimaUsd : SPESA_MASSIMA_USD;
  const tetto = Math.min(valoreResiduoUsd, tettoAssoluto);
  const limitatoDa = tetto === valoreResiduoUsd && valoreResiduoUsd <= tettoAssoluto ? 'valore' : 'assoluto';
  if (!(tetto > 0)) {
    return no(`il residuo vale $${valoreResiduoUsd.toFixed(4)}: non c'è niente da spendere per sbloccarlo`,
      { valoreResiduoUsd });
  }

  // ⚠ SERVE LA SCALA DEGLI ASK, e non si presume. Senza, non si sa quanto costerebbe l'altro lato: è
  // la stessa distinzione fra «ho camminato la scala e costa troppo» e «la scala non me l'hanno data»
  // che `quantoAlVolo` fa da agosto (§5-bis p.27).
  if (!Array.isArray(asksAltroLato) || asksAltroLato.length === 0) {
    return no('scala ask dell\'altro lato non disponibile: il costo dello sblocco non è calcolabile,'
      + ' e un prezzo non letto non si presume né buono né cattivo', { valoreResiduoUsd, tetto, limitatoDa });
  }

  // ── SI CAMMINA LA SCALA, E CI SI FERMA AL TETTO IN DOLLARI ────────────────────────────────────
  // ⚠ TUTTO O NIENTE. Comprare metà dell'altro lato non sblocca niente: resterebbe un residuo su
  // ENTRAMBI i lati, cioè due gambe sotto il minimo invece di una. Il merge vuole la coppia intera.
  let size = 0; let costo = 0; let peggiore = null;
  for (const l of asksAltroLato) {
    if (size >= sizeResidua - 1e-9) break;
    const price = typeof l?.price === 'string' ? parseFloat(l.price) : l?.price;
    const disp = typeof l?.size === 'string' ? parseFloat(l.size) : l?.size;
    if (!fin(price) || !fin(disp) || price <= 0 || disp <= 0) continue;
    const presa = Math.min(disp, sizeResidua - size);
    const costoNuovo = costo + presa * price;
    // ⚠ Il tetto si controlla sul costo TOTALE, non livello per livello: è una spesa unica.
    if (costoNuovo > tetto + 1e-9) break;
    size += presa; costo = costoNuovo; peggiore = price;
  }

  if (size < sizeResidua - 1e-9) {
    // ⚠ QUESTO È IL RAMO CHE L'OPERATORE HA CHIESTO DI DICHIARARE: «se nemmeno così si chiude,
    // dichiara e lascia stare». Si dice quanto sarebbe servito, così il costo del NON curare è
    // misurato invece che supposto.
    const servirebbero = asksAltroLato.reduce((acc, l) => {
      if (acc.size >= sizeResidua - 1e-9) return acc;
      const price = typeof l?.price === 'string' ? parseFloat(l.price) : l?.price;
      const disp = typeof l?.size === 'string' ? parseFloat(l.size) : l?.size;
      if (!fin(price) || !fin(disp) || price <= 0 || disp <= 0) return acc;
      const presa = Math.min(disp, sizeResidua - acc.size);
      return { size: acc.size + presa, costo: acc.costo + presa * price };
    }, { size: 0, costo: 0 });
    const bastano = servirebbero.size >= sizeResidua - 1e-9;
    return no(
      `sbloccare ${sizeResidua} share costerebbe ${bastano ? `$${servirebbero.costo.toFixed(4)}` : 'più del book disponibile'}`
      + `, oltre il tetto di $${tetto.toFixed(4)} (${limitatoDa === 'valore' ? `il residuo vale $${valoreResiduoUsd.toFixed(4)}` : `massimo assoluto $${tettoAssoluto}`})`
      + ' — non si compra, e si aspetta la risoluzione',
      { valoreResiduoUsd, tetto, limitatoDa,
        costoNecessarioUsd: bastano ? +servirebbero.costo.toFixed(6) : null });
  }

  const prezzoMedio = +(costo / size).toFixed(6);
  return {
    sblocca: true, size: +size.toFixed(6), costoUsd: +costo.toFixed(6), prezzoMedio,
    prezzoPeggiore: peggiore, valoreResiduoUsd, tetto, limitatoDa,
    motivo: `si sblocca comprando ${size.toFixed(2)} share dell'altro lato a ${(prezzoMedio * 100).toFixed(1)}¢ medi`
      + ` = $${costo.toFixed(4)}, entro il tetto di $${tetto.toFixed(4)}`
      + ` (${limitatoDa === 'valore' ? `valore del residuo $${valoreResiduoUsd.toFixed(4)}` : `massimo assoluto $${tettoAssoluto}`})`
      + ' — poi la coppia si fonde, e il merge on-chain non ha minimi di size',
  };
}

/** Prove interne. Girano con `node lib/maker/sblocco-residuo.js`. */
function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

  // ── IL CASO REALE: Hong Kong, 6 share a carico 0,50 ───────────────────────────────────────────
  // Valore $3,00. L'altro lato a 40¢ costerebbe $2,40: sotto entrambi i tetti ⇒ si sblocca.
  const hk = valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.50, asksAltroLato: [{ price: 0.40, size: 100 }] });
  ok('Hong Kong (6 share, valore $3,00), altro lato a 40¢ ⇒ SI SBLOCCA', hk.sblocca === true);
  ok('  costo $2,40', Math.abs(hk.costoUsd - 2.40) < 1e-6, String(hk.costoUsd));
  ok('  e il tetto che morde è il VALORE, non l\'assoluto', hk.limitatoDa === 'valore' && hk.tetto === 3);
  ok('  la coppia costa 90¢, sotto la pari: qui non serviva nemmeno la deroga',
    Math.abs((0.50 + hk.prezzoMedio) - 0.90) < 1e-9);

  // ── IL CASO CHE LA REGOLA ESISTE PER AUTORIZZARE: la coppia costa OLTRE 101¢ ───────────────────
  // ⚠ È IL PUNTO DI R6, e va costruito con cura. Residuo di 6 share comprate a **60¢** (valore
  // corrente $3,60), altro lato a **45¢**: la coppia costa **105¢**, cioè il tetto di §4.6 la
  // rifiuterebbe — «non è profittevole», ed è vero. Ma la spesa è $2,70, sotto entrambi i tetti di
  // R6, e sblocca $3,60 di capitale che altrimenti resta fermo fino alla risoluzione.
  const oltre = valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.60, asksAltroLato: [{ price: 0.45, size: 100 }] });
  ok('coppia a 105¢ (oltre il tetto di 101) ⇒ SI SBLOCCA LO STESSO: è il punto di R6', oltre.sblocca === true,
    oltre.motivo);
  ok('  e la coppia costa davvero più di 100¢', (0.60 + oltre.prezzoMedio) > 1.0);
  ok('  spesa $2,70, entro il valore $3,60 e il massimo $5',
    Math.abs(oltre.costoUsd - 2.70) < 1e-9 && oltre.tetto === 3.6);
  // ⚠ E LO STESSO CASO CON L'ALTRO LATO PIÙ CARO SI RIFIUTA: 6 share a 50¢ (valore $3,00) con l'altro
  // lato a 55¢ costa $3,30 > $3,00. Il tetto del VALORE morde, e la coppia resta bloccata.
  const troppo = valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.50, asksAltroLato: [{ price: 0.55, size: 100 }] });
  ok('  ma spendere $3,30 per sbloccare $3,00 si RIFIUTA', troppo.sblocca === false);
  ok('    e il motivo dice entrambi i numeri', /\$3\.3000/.test(troppo.motivo) && /\$3\.0000/.test(troppo.motivo),
    troppo.motivo.slice(0, 120));

  // ── I DUE TETTI, UNO ALLA VOLTA ───────────────────────────────────────────────────────────────
  // ① il VALORE morde: residuo piccolo, altro lato caro.
  const perValore = valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.20, asksAltroLato: [{ price: 0.60, size: 100 }] });
  ok('residuo che vale $1,20 e altro lato da $3,60 ⇒ NON si sblocca', perValore.sblocca === false);
  ok('  e il motivo dice quanto sarebbe servito', /\$3\.6000/.test(perValore.motivo), perValore.motivo.slice(0, 90));
  ok('  e quanto si poteva spendere', perValore.tetto === 1.2 && perValore.limitatoDa === 'valore');
  // ② l'ASSOLUTO morde: residuo grande, altro lato che costerebbe più di $5.
  const perAssoluto = valutaSblocco({ sizeResidua: 40, prezzoCorrente: 0.90, asksAltroLato: [{ price: 0.30, size: 100 }] });
  ok('residuo che vale $36 ma sbloccarlo costa $12 ⇒ NON si sblocca (tetto assoluto $5)',
    perAssoluto.sblocca === false && perAssoluto.tetto === SPESA_MASSIMA_USD && perAssoluto.limitatoDa === 'assoluto');
  // ③ dentro entrambi.
  const dentro = valutaSblocco({ sizeResidua: 40, prezzoCorrente: 0.90, asksAltroLato: [{ price: 0.10, size: 100 }] });
  ok('lo stesso residuo con l\'altro lato a 10¢ ⇒ $4,00, dentro entrambi i tetti', dentro.sblocca === true
    && Math.abs(dentro.costoUsd - 4) < 1e-9);
  ok('  e il tetto dichiarato è l\'assoluto', dentro.limitatoDa === 'assoluto' && dentro.tetto === 5);

  // ── TUTTO O NIENTE ────────────────────────────────────────────────────────────────────────────
  // ⚠ Comprare metà dell'altro lato lascerebbe un residuo su ENTRAMBI i lati: due gambe sotto il
  // minimo invece di una. È strettamente peggio di non fare niente.
  const parziale = valutaSblocco({ sizeResidua: 10, prezzoCorrente: 0.50,
    asksAltroLato: [{ price: 0.10, size: 4 }] });   // solo 4 share disponibili
  ok('book che copre solo 4 share su 10 ⇒ NON si compra niente', parziale.sblocca === false && parziale.size === 0);
  ok('  e si dichiara che il book non basta', /più del book disponibile/.test(parziale.motivo));
  // La scala a più livelli invece si cammina.
  const scala = valutaSblocco({ sizeResidua: 10, prezzoCorrente: 0.50,
    asksAltroLato: [{ price: 0.10, size: 4 }, { price: 0.20, size: 6 }] });
  ok('due livelli che insieme coprono la size ⇒ si sblocca', scala.sblocca === true && scala.size === 10);
  ok('  al costo dei due livelli, $1,60', Math.abs(scala.costoUsd - 1.6) < 1e-9, String(scala.costoUsd));
  ok('  e il prezzo peggiore è quello dell\'ultimo livello toccato', scala.prezzoPeggiore === 0.20);

  // ── FAIL-CLOSED ───────────────────────────────────────────────────────────────────────────────
  ok('nessun residuo ⇒ niente', valutaSblocco({ sizeResidua: 0, prezzoCorrente: 0.5 }).sblocca === false);
  ok('prezzo corrente non leggibile ⇒ NON si compra al buio',
    valutaSblocco({ sizeResidua: 6, prezzoCorrente: null, asksAltroLato: [{ price: 0.1, size: 100 }] }).sblocca === false);
  ok('  e lo dichiara', /non si compra al buio/.test(
    valutaSblocco({ sizeResidua: 6, prezzoCorrente: null, asksAltroLato: [{ price: 0.1, size: 100 }] }).motivo));
  ok('scala ask assente ⇒ non si presume niente',
    valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.5, asksAltroLato: null }).sblocca === false);
  ok('scala ask VUOTA ⇒ idem (non è «gratis»)',
    valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.5, asksAltroLato: [] }).sblocca === false);
  ok('livelli malformati vengono saltati, non presunti',
    valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.5,
      asksAltroLato: [{ price: 'boh', size: 100 }, { price: 0.1, size: 100 }] }).sblocca === true);
  ok('un tetto assoluto assurdo vale il difetto, non l\'infinito',
    valutaSblocco({ sizeResidua: 40, prezzoCorrente: 0.9, spesaMassimaUsd: -1,
      asksAltroLato: [{ price: 0.30, size: 100 }] }).sblocca === false);

  // ── IL TETTO È IN DOLLARI, E SI VEDE ──────────────────────────────────────────────────────────
  // ⚠ Due residui con lo stesso «quanto sopra la pari» ma size diverse ricevono risposte diverse: è
  // esattamente ciò che un tetto per share NON saprebbe fare, ed è la ragione della scelta.
  const piccolo = valutaSblocco({ sizeResidua: 6, prezzoCorrente: 0.50, asksAltroLato: [{ price: 0.45, size: 1000 }] });
  const grande = valutaSblocco({ sizeResidua: 60, prezzoCorrente: 0.50, asksAltroLato: [{ price: 0.45, size: 1000 }] });
  ok('coppia a 95¢ su 6 share ($2,70) ⇒ si sblocca', piccolo.sblocca === true);
  ok('  la STESSA coppia a 95¢ su 60 share ($27) ⇒ NO, il tetto assoluto morde', grande.sblocca === false);
  ok('  ed è la differenza che un tetto per SHARE non saprebbe esprimere', piccolo.sblocca !== grande.sblocca);

  // ── NESSUN `require` ──────────────────────────────────────────────────────────────────────────
  {
    const src = require('fs').readFileSync(__filename, 'utf8');
    const righe = src.split('\n').filter((l) => /\brequire\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)
      && !/readFileSync\(__filename/.test(l));
    ok('il modulo non ha nessun `require` fuori dal selfcheck', righe.length === 0, righe.join(' | '));
  }

  console.log(`\nsblocco residuo: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { valutaSblocco, SPESA_MASSIMA_USD };

'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  CHI PROPONE DEVE SAPERE COSA CHI RICEVE ACCETTA
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ LA CLASSE DI DIFETTO, con due occorrenze misurate. Il pianificatore costruisce righe; la corsia di
 * piazzamento le giudica con soglie **sue**. Finché nessuno confronta le due, il pianificatore produce
 * righe destinate al rifiuto e nessuno se ne accorge — perché ogni modulo, preso da solo, risponde
 * correttamente alla propria domanda.
 *
 *  ① **13 agosto 2026, tre ore di capitale fermo.** La griglia allocava $24,00 per mercato, il
 *     mini-ciclo ne chiedeva $24,50: **114 rifiuti identici**, e zero ordini sul book.
 *  ② **631 rifiuti `manual-order-cap` in tre giorni.** Il piano alloca fino al **tetto per mercato**
 *     ($32,67) senza sapere che esiste un **tetto per ORDINE** ($21,34). Le due gambe di una coppia
 *     costano `Q × p_yes` e `Q × p_no` con `Q = capitale / costoCoppia`: a mid estremo la gamba cara
 *     sfonda. **Misurato sul board di oggi: 243 mercati su 321 (76%) hanno la gamba cara oltre il
 *     tetto per ordine se allocati al tetto pieno.**
 *
 * ═══ COSA FA — SI ADATTA, NON ALLENTA ══════════════════════════════════════════════════════════════
 * Prima che le righe vengano proposte, si calcola il capitale **massimo compatibile con TUTTE le
 * soglie di chi riceve** e lo si applica. Il capitale può solo **SCENDERE**: è un `Math.min` su una
 * soglia che resta esattamente dov'è. Nessun tetto viene alzato, nessuna banda allargata, nessun
 * cancello saltato — la riga smette di essere impossibile diventando **più piccola**, non più permessa.
 *
 * ⚠ E se nemmeno la riga più piccola è accettabile, la riga **si scarta e si dichiara**. Non si forza
 * una size sotto il pavimento premiante per «riuscire a piazzare qualcosa»: sotto `min_incentive_size`
 * il reward è ZERO, quindi un ordine forzato lì immobilizza capitale per niente.
 *
 * ═══ EFFETTO COLLATERALE, e va nella direzione giusta ═══════════════════════════════════════════════
 * `f_min = minSize × costoCoppia / capitale`: abbassando il capitale, `f_min` **sale**. Cioè una riga
 * adattata lascia un residuo scoperto piazzabile più spesso — è il problema dei residui murati, che
 * diminuisce invece di peggiorare.
 *
 * Modulo **puro**: riceve numeri, restituisce numeri. Non conosce il venue, non conosce il disco, e non
 * importa nessuna costante — le soglie gliele passa chi le possiede, così non può nascere qui una
 * settima copia del tetto.
 */

const fin = (v) => Number.isFinite(v);

/**
 * IL CAPITALE MASSIMO DI UNA RIGA CHE PASSA ANCHE IL TETTO PER ORDINE.
 *
 * Le due gambe comprano le **stesse share** `Q = capitale / costoCoppia` e costano `Q × p` ciascuna,
 * con `p` il prezzo del proprio lato. La cara è quella al prezzo `max(p_yes, p_no)`. Quindi:
 *
 *     Q × p_max ≤ tettoOrdine    ⇒    capitale ≤ tettoOrdine × costoCoppia / p_max
 *
 * `null` quando manca un ingrediente: non si indovina, e chi legge tratta l'incognita come «non
 * adattabile», che lascia il comportamento di prima.
 */
function capitaleMassimoPerOrdine({ prezzoMax = null, costoCoppia = null, tettoOrdineUsd = null } = {}) {
  if (!fin(prezzoMax) || prezzoMax <= 0 || !fin(costoCoppia) || costoCoppia <= 0 || !fin(tettoOrdineUsd) || tettoOrdineUsd <= 0) return null;
  return +(tettoOrdineUsd * costoCoppia / prezzoMax).toFixed(2);
}

/** Il prezzo del lato caro di una riga, letto dai campi che il piano già porta. */
function prezzoLatoCaro(riga) {
  const r = riga || {};
  const cand = [r.snappedAsk, r.snappedBid, r.mid, r.midpoint, r.rif && r.rif.scoringMid].filter((x) => fin(x) && x > 0 && x < 1);
  if (!cand.length) return null;
  const mid = fin(r.mid) && r.mid > 0 && r.mid < 1 ? r.mid : (fin(r.midpoint) ? r.midpoint : cand[0]);
  if (!fin(mid) || mid <= 0 || mid >= 1) return null;
  return Math.max(mid, 1 - mid);
}

/**
 * Verifica UNA riga contro le soglie di chi la riceve, e la adatta se basta ridurre il capitale.
 *
 * @param soglie `{capPerMercatoUsd, tettoOrdineUsd, pavimentoRigaUsd}` — tutte possedute da altri
 * @returns `{ok, capitale, adattata, scartata, motivo, divergenza}`
 */
function verificaRiga(riga, soglie = {}) {
  const r = riga || {};
  const cap0 = fin(r.capital) ? r.capital : null;
  const { capPerMercatoUsd = null, tettoOrdineUsd = null, pavimentoRigaUsd = null } = soglie;
  if (!fin(cap0) || cap0 <= 0) {
    return { ok: false, capitale: null, adattata: false, scartata: true, motivo: 'la riga non dichiara un capitale leggibile', divergenza: null };
  }

  let cap = cap0;
  const vincoli = [];
  if (fin(capPerMercatoUsd) && capPerMercatoUsd > 0 && cap > capPerMercatoUsd) { cap = capPerMercatoUsd; vincoli.push('tetto per mercato'); }

  const pMax = prezzoLatoCaro(r);
  const costo = fin(r.pairCostUsd) && r.pairCostUsd > 0 ? r.pairCostUsd : null;
  const maxOrdine = capitaleMassimoPerOrdine({ prezzoMax: pMax, costoCoppia: costo, tettoOrdineUsd });
  // ⚠ Se il tetto per ordine non è calcolabile NON si adatta: si lascia la riga com'è e il gate a valle
  // deciderà. Adattare su un'incognita vorrebbe dire ridurre il capitale per un vincolo immaginario.
  if (maxOrdine != null && cap > maxOrdine) { cap = maxOrdine; vincoli.push('tetto per ordine (gamba cara)'); }

  const pavimento = fin(pavimentoRigaUsd) && pavimentoRigaUsd > 0 ? pavimentoRigaUsd : null;
  if (pavimento != null && cap < pavimento) {
    return {
      ok: false, capitale: null, adattata: false, scartata: true,
      motivo: `nessun capitale soddisfa insieme le soglie: il massimo compatibile è $${cap.toFixed(2)}, sotto il pavimento premiante di $${pavimento.toFixed(2)}`,
      divergenza: { proposto: cap0, massimoCompatibile: cap, pavimento, vincoli },
    };
  }

  const adattata = +cap.toFixed(2) < +cap0.toFixed(2);
  return {
    ok: true, capitale: +cap.toFixed(2), adattata, scartata: false,
    motivo: adattata ? `capitale ridotto da $${cap0.toFixed(2)} a $${cap.toFixed(2)} per: ${vincoli.join(' · ')}` : null,
    divergenza: adattata ? { proposto: cap0, massimoCompatibile: +cap.toFixed(2), vincoli } : null,
  };
}

/**
 * Tutte le righe, in un colpo. Restituisce le righe **adattate** — non un giudizio da applicare
 * altrove: chi chiama usa queste e basta, o le due liste tornerebbero a divergere.
 *
 * `pavimentoDi` e `sogliePer` sono iniettate perché le soglie vivono nei loro moduli. Questo modulo non
 * le importa **di proposito**: sono già dichiarate una volta sola altrove, e importarle qui creerebbe
 * il settimo consumatore da tenere allineato — cioè esattamente il difetto che sta chiudendo.
 */
function adattaRighe({ righe = [], soglieDi = null } = {}) {
  const fuori = [];
  const divergenze = [];
  const out = [];
  for (const r of (righe || [])) {
    let soglie = {};
    try { soglie = typeof soglieDi === 'function' ? (soglieDi(r) || {}) : {}; }
    catch { soglie = {}; }          // soglie non calcolabili ⇒ nessun adattamento, comportamento di prima
    const v = verificaRiga(r, soglie);
    if (v.scartata) { fuori.push({ marketId: r && r.marketId, motivo: v.motivo, divergenza: v.divergenza }); continue; }
    if (v.adattata) {
      divergenze.push({ marketId: r && r.marketId, ...v.divergenza });
      // ⚠ Si riscrive SOLO il capitale. Le share per lato le ricalcola `scegliMercato` a valle con
      // `shareARiscalo`, che è l'unica formula capitale→share del repo: rifarle qui sarebbe la seconda.
      out.push({ ...r, capital: v.capitale });
    } else out.push(r);
  }
  return { righe: out, adattate: divergenze.length, scartate: fuori, divergenze };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) p += 1; else { f += 1; console.error('  ✗', n); } };
  const riga = (o = {}) => ({ marketId: '0x' + 'a'.repeat(64), capital: 32.67, pairCostUsd: 0.98, mid: 0.5, minSizeShares: 20, ...o });
  const S = { capPerMercatoUsd: 32.67, tettoOrdineUsd: 21.34, pavimentoRigaUsd: 19.6 };

  ok('a mid 0,50 nessun vincolo morde', verificaRiga(riga(), S).adattata === false);
  ok('a mid 0,80 la gamba cara sfonda e il capitale SCENDE', (() => {
    const v = verificaRiga(riga({ mid: 0.8 }), S);
    return v.ok && v.adattata && v.capitale === +(21.34 * 0.98 / 0.8).toFixed(2) && v.capitale < 32.67;
  })());
  ok('  e la gamba cara adattata sta sotto il tetto per ordine', (() => {
    const v = verificaRiga(riga({ mid: 0.8 }), S);
    return (v.capitale / 0.98) * 0.8 <= 21.34 + 0.01;
  })());
  ok('il caso reale di Vindman (mid 0,8675) rientra', (() => {
    const v = verificaRiga(riga({ mid: 0.8675 }), S);
    return v.ok && (v.capitale / 0.98) * 0.8675 <= 21.35;
  })());
  ok('il capitale può solo SCENDERE, mai salire', (() => {
    for (let m = 0.05; m < 0.96; m += 0.05) {
      const v = verificaRiga(riga({ mid: +m.toFixed(2) }), S);
      if (v.ok && v.capitale > 32.67 + 1e-9) return false;
    }
    return true;
  })());
  ok('una riga che non regge nemmeno il pavimento si SCARTA e lo dichiara', (() => {
    const v = verificaRiga(riga({ mid: 0.5, minSizeShares: 200 }), { ...S, pavimentoRigaUsd: 196 });
    return v.scartata && /sotto il pavimento premiante/.test(v.motivo);
  })());
  ok('tetto per ordine non calcolabile ⇒ nessun adattamento inventato',
    verificaRiga(riga({ mid: 0.9 }), { capPerMercatoUsd: 32.67, pavimentoRigaUsd: 19.6 }).adattata === false);
  ok('mid illeggibile ⇒ nessun adattamento', verificaRiga(riga({ mid: null, midpoint: null, snappedAsk: null, snappedBid: null }), S).adattata === false);
  ok('capitale illeggibile ⇒ riga scartata, non indovinata', verificaRiga(riga({ capital: null }), S).scartata === true);

  const molte = [riga({ mid: 0.5 }), riga({ mid: 0.85, marketId: '0xb' }), riga({ mid: 0.5, minSizeShares: 200, marketId: '0xc' })];
  const r = adattaRighe({ righe: molte, soglieDi: (x) => ({ ...S, pavimentoRigaUsd: (x.minSizeShares || 20) * 0.98 }) });
  ok('adattaRighe restituisce le righe GIÀ adattate', r.righe.length === 2 && r.adattate === 1 && r.scartate.length === 1);
  ok('  e le divergenze sono dichiarate con i numeri', r.divergenze[0].proposto === 32.67 && r.divergenze[0].massimoCompatibile < 32.67);
  ok('soglie non calcolabili ⇒ righe intatte', (() => {
    const q = adattaRighe({ righe: [riga({ mid: 0.9 })], soglieDi: () => { throw new Error('x'); } });
    return q.righe.length === 1 && q.adattate === 0 && q.righe[0].capital === 32.67;
  })());
  ok('non si ricalcolano le share qui: si tocca solo il capitale', (() => {
    const q = adattaRighe({ righe: [riga({ mid: 0.85, sizePerSideShares: 33.3 })], soglieDi: () => S });
    return q.righe[0].sizePerSideShares === 33.3;
  })());
  // Si guardano le sole righe di `require`: cercare il nome della costante in tutto il sorgente fa
  // cadere l'asserzione sulla riga che la nomina per dire che NON la importa — la stessa trappola già
  // registrata in `sblocco-progressivo`.
  ok('il modulo non importa nessuna costante di rischio: le soglie gliele passa chi le possiede', (() => {
    const src = require('fs').readFileSync(__filename, 'utf8');
    const requires = src.split('\n').filter((l) => /require\s*\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    return requires.every((l) => /require\('fs'\)/.test(l));
  })());

  console.log(`coerenza-soglie selfcheck: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { verificaRiga, adattaRighe, capitaleMassimoPerOrdine, prezzoLatoCaro, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

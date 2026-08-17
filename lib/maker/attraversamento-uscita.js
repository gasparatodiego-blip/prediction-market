'use strict';
// lib/maker/attraversamento-uscita.js — QUANDO L'USCITA PUO' ATTRAVERSARE LO SPREAD. PURO.
//
// ═══ IL PERMESSO PIU' PERICOLOSO CHE IL BOT ABBIA ═══════════════════════════════════════════════════
// Concesso dall'operatore il 17 agosto 2026, con quattro limiti dichiarati parola per parola. Questo
// modulo NON e' la comodita' di aver messo la logica altrove: e' il posto in cui i quattro limiti si
// leggono tutti insieme, in venti righe, senza dover ricostruire il percorso attraverso `auto-close`,
// `manual-order` e l'adapter. Un permesso che si puo' leggere solo camminando tre file e' un permesso
// che nessuno rilegge.
//
// ═══ PERCHE' SERVE ══════════════════════════════════════════════════════════════════════════════════
// Il 16 agosto il bot ha mandato al venue 146 ordini SELL su FL-02 in 2h36m e NESSUNO e' stato
// eseguito: erano `post-only`, e un `post-only` al prezzo del bid viene rifiutato
// (`invalid post-only order: order crosses book`). Un'uscita che non puo' attraversare si esegue solo
// se il mercato viene a prenderla — e il mercato non e' venuto. In tutta la giornata l'unica vendita
// eseguita e' stata quella in cui una mano umana ha dichiarato `cross-dichiarato`.
//
// ═══ I QUATTRO LIMITI, COME SONO STATI DETTI ════════════════════════════════════════════════════════
//   ① `postOnly:false` SOLO su un ordine di USCITA o di COMPLETAMENTO COPPIA, mai su un'apertura di
//      liquidita'. ⚠ Questo limite NON e' imposto qui: e' gia' strutturale in `manual-order.js:1100`,
//      dove `attraversaApposta` puo' essere vero solo per una SELL dichiarata o per un completamento
//      di coppia PROVATO. Questo modulo non lo puo' allargare — puo' solo non usarlo. Lo si ripete
//      qui perche' chi legge sappia dov'e', non perche' sia applicato due volte.
//   ② Consentito solo dal GRADINO 1 in su. Al gradino 0 l'uscita resta post-only.
//   ③ Il prezzo non puo' scendere sotto il PAVIMENTO che la scala concede a quel gradino:
//      attraversare non significa svendere.
//   ④ Ogni attraversamento si DICHIARA nel giornale con gradino, prezzo, bid colpito e perdita
//      rispetto al carico.
//
// ⚠ IL LIMITE ③ E' GIA' APPLICATO A MONTE dal calcolo del prezzo (`Math.max(pavimento, …)`), e qui si
// RIVERIFICA. Non e' ridondanza inutile: e' la differenza fra «il prezzo dovrebbe essere sopra il
// pavimento» e «non attraverso se non lo e'». Se un giorno il calcolo a monte cambiasse, il permesso
// di attraversare non seguirebbe il cambiamento in silenzio.
//
// ⚠ ZERO `require`: stessa disciplina di `copertura-gambe`, `presa-di-profitto`, `carico-di-ripiego`.

const GRADINO_MINIMO = 1;   // ② — al gradino 0 non si attraversa mai

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * SI PUO' ATTRAVERSARE CON QUESTO ORDINE?
 *
 * @param a.tipo        'uscita' | 'completamento-coppia' | qualunque altra cosa
 * @param a.gradino     il gradino della scala d'urgenza (0..3)
 * @param a.prezzo      il prezzo che si sta per mandare
 * @param a.pavimento   il minimo che la scala concede a questo gradino
 * @param a.bid         il miglior bid del lato che si vende
 * @param a.carico      il prezzo medio di carico
 * @returns {{attraversa:boolean, motivo:string, dichiarazione:object|null}}
 */
function valutaAttraversamento(a = {}) {
  const no = (motivo) => ({ attraversa: false, motivo, dichiarazione: null });

  // ① Solo uscita o completamento coppia. Un'apertura di liquidita' non attraversa MAI.
  const tipo = typeof a.tipo === 'string' ? a.tipo.trim().toLowerCase() : '';
  if (tipo !== 'uscita' && tipo !== 'completamento-coppia') {
    return no(`tipo «${tipo || 'non dichiarato'}»: si attraversa solo su un'uscita o un completamento di coppia`);
  }

  // ② Dal gradino 1 in su.
  // ⚠ GRADINO NON LEGGIBILE ⇒ NON SI ATTRAVERSA. `Number(null) === 0` darebbe gradino 0, che qui
  // coincide col rifiuto — ma per la ragione sbagliata, e domani un cambio di soglia lo rovescerebbe.
  if (!fin(a.gradino)) return no('gradino della scala non leggibile: non si attraversa su un permesso che non si e\' letto');
  if (a.gradino < GRADINO_MINIMO) {
    return no(`gradino ${a.gradino}: al gradino 0 la scala non ha concesso niente e l'uscita resta post-only`);
  }

  // ③ Mai sotto il pavimento.
  if (!fin(a.prezzo) || !(a.prezzo > 0)) return no('prezzo non leggibile');
  if (!fin(a.pavimento)) return no('pavimento della scala non leggibile: attraversare senza sapere quanto si puo\' perdere e\' svendere');
  if (a.prezzo < a.pavimento - 1e-9) {
    return no(`prezzo ${a.prezzo} sotto il pavimento ${a.pavimento} concesso al gradino ${a.gradino}:`
      + ' attraversare non significa svendere');
  }

  // Il bid: serve sia per sapere se si sta davvero incrociando, sia per la dichiarazione ④.
  if (!fin(a.bid) || !(a.bid > 0)) return no('miglior bid non leggibile: non si dichiara un attraversamento che non si sa se avviene');

  // ⚠ SE IL PREZZO NON INCROCIA, NON SERVE IL PERMESSO — e non lo si chiede. Un ordine sopra il bid
  // resta `post-only` e va benissimo: chiedere la deroga quando non serve sporcherebbe il conteggio
  // degli attraversamenti, che e' il numero con cui domani si giudica questa decisione.
  if (a.prezzo > a.bid + 1e-9) {
    return no(`il prezzo ${a.prezzo} sta sopra il bid ${a.bid}: non incrocia, resta post-only`);
  }

  // ④ La dichiarazione. Si costruisce QUI, insieme al permesso, cosi' non puo' esistere un
  // attraversamento senza la sua riga a verbale.
  const perditaVsCarico = fin(a.carico) ? +(a.prezzo - a.carico).toFixed(6) : null;
  return {
    attraversa: true,
    motivo: `gradino ${a.gradino}: la scala concede fino a ${a.pavimento} e il prezzo ${a.prezzo} colpisce`
      + ` il bid ${a.bid} restando sopra il pavimento`,
    dichiarazione: {
      gradino: a.gradino,
      prezzo: a.prezzo,
      bidColpito: a.bid,
      pavimento: a.pavimento,
      carico: fin(a.carico) ? a.carico : null,
      perditaVsCaricoUsdPerShare: perditaVsCarico,
      perditaVsCaricoCents: perditaVsCarico === null ? null : +(perditaVsCarico * 100).toFixed(3),
      inGuadagno: perditaVsCarico === null ? null : perditaVsCarico >= 0,
      tipo,
    },
  };
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ attraversamento-uscita ════');

  // Il caso buono: uscita, gradino 2, prezzo 0,53 = pavimento, bid 0,53.
  const base = { tipo: 'uscita', gradino: 2, prezzo: 0.53, pavimento: 0.53, bid: 0.53, carico: 0.54 };
  const buono = valutaAttraversamento(base);
  ok('uscita al gradino 2, prezzo sul pavimento e sul bid ⇒ ATTRAVERSA', buono.attraversa === true, buono.motivo);
  ok('  e la dichiarazione porta gradino, prezzo, bid e perdita',
    buono.dichiarazione.gradino === 2 && buono.dichiarazione.prezzo === 0.53
    && buono.dichiarazione.bidColpito === 0.53 && buono.dichiarazione.perditaVsCaricoCents === -1,
    JSON.stringify(buono.dichiarazione));
  ok('  e dice che NON e in guadagno', buono.dichiarazione.inGuadagno === false);

  ok('① un\'apertura di liquidita non attraversa MAI',
    valutaAttraversamento({ ...base, tipo: 'liquidita' }).attraversa === false);
  ok('  ne un tipo non dichiarato', valutaAttraversamento({ ...base, tipo: undefined }).attraversa === false);
  ok('  ma il completamento della coppia si',
    valutaAttraversamento({ ...base, tipo: 'completamento-coppia' }).attraversa === true);

  ok('② al gradino 0 NON si attraversa', valutaAttraversamento({ ...base, gradino: 0 }).attraversa === false);
  ok('  al gradino 1 si', valutaAttraversamento({ ...base, gradino: 1 }).attraversa === true);
  ok('  gradino non leggibile ⇒ NON si attraversa',
    valutaAttraversamento({ ...base, gradino: null }).attraversa === false);

  ok('③ sotto il pavimento NON si attraversa',
    valutaAttraversamento({ ...base, prezzo: 0.52, pavimento: 0.53, bid: 0.52 }).attraversa === false);
  ok('  pavimento non leggibile ⇒ NON si attraversa',
    valutaAttraversamento({ ...base, pavimento: null }).attraversa === false);
  ok('  esattamente SUL pavimento si attraversa (il confine non si anticipa)',
    valutaAttraversamento({ ...base, prezzo: 0.53, pavimento: 0.53 }).attraversa === true);

  ok('un prezzo SOPRA il bid non chiede il permesso: resta post-only',
    valutaAttraversamento({ ...base, prezzo: 0.55, pavimento: 0.53, bid: 0.53 }).attraversa === false);
  ok('bid non leggibile ⇒ NON si attraversa',
    valutaAttraversamento({ ...base, bid: null }).attraversa === false);
  ok('prezzo non leggibile ⇒ NON si attraversa',
    valutaAttraversamento({ ...base, prezzo: null }).attraversa === false);

  ok('un attraversamento in GUADAGNO e dichiarato tale', (() => {
    const g = valutaAttraversamento({ tipo: 'uscita', gradino: 1, prezzo: 0.56, pavimento: 0.54, bid: 0.56, carico: 0.54 });
    return g.attraversa === true && g.dichiarazione.inGuadagno === true && g.dichiarazione.perditaVsCaricoCents === 2;
  })());
  ok('carico non leggibile ⇒ si attraversa ma la perdita e dichiarata null, non zero', (() => {
    const g = valutaAttraversamento({ ...base, carico: null });
    return g.attraversa === true && g.dichiarazione.perditaVsCaricoCents === null && g.dichiarazione.inGuadagno === null;
  })());

  console.log(`\nattraversamento-uscita selfcheck: ${p} verdi, ${f} rossi`);
  return f === 0;
}

module.exports = { valutaAttraversamento, GRADINO_MINIMO, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

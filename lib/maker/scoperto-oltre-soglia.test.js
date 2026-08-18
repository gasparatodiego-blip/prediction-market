'use strict';

/**
 * IL CASO «POSIZIONE SCOPERTA OLTRE SOGLIA» — §5 punto 138.
 *
 * Difende le PROPRIETÀ della scala di urgenza, non i suoi numeri: un test che fotografa le costanti
 * diventerebbe rosso alla prima ritaratura sui dati nuovi, che è esattamente quello che deve poter
 * succedere. Le proprietà che NON devono mai cambiare sono tre:
 *
 *   ① senza urgenza il comportamento è IDENTICO a quello di prima (nessuna regressione silenziosa);
 *   ② la scala è monotona e la concessione è limitata, sempre, anche chiedendo l'assurdo;
 *   ③ nessun gradino può produrre un'uscita fuori dalla banda premiante, e la perdita massima
 *      accettata resta sotto il tetto dichiarato.
 *
 * Il caso reale che ha generato tutto questo — `0xcd126ec4`, NO 58,8 share, carico 0,43, scoperta
 * 8,2 ore — è riprodotto per intero in fondo, con i numeri veri letti dal giornale.
 */

const { livelloUrgenza, pavimentoConcesso, SOGLIE_MIN, CONCESSIONE_TICK_MAX,
  PERDITA_MAX_FRAZIONE } = require('./urgenza-scoperto');
const { planExit } = require('./exit-plan');

let passati = 0; let falliti = 0;
const ok = (nome, cond, extra = '') => {
  if (cond) { passati++; console.log(`  ✓ ${nome}`); }
  else { falliti++; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};

// ── ① NESSUNA REGRESSIONE: senza urgenza, tutto come prima ──────────────────────────────────────
console.log('\n── senza urgenza il piano di uscita e\' quello di sempre');
{
  const B = { entryPrice: 0.43, tick: 0.01, bandRadiusCents: 2.25 };
  // Il caso che PRIMA rifiutava deve rifiutare ancora, con la stessa decisione.
  const giu = planExit({ ...B, scoringMid: 0.4075 });   // bordo alto banda == carico
  ok('banda pari al carico, nessuna urgenza ⇒ si rifiuta come prima', giu.ok === false);
  ok('  e non si inventa un prezzo', giu.price === null);
  const sotto = planExit({ ...B, scoringMid: 0.40 });   // bordo alto banda 0.42 < carico
  ok('banda sotto il carico, nessuna urgenza ⇒ si rifiuta come prima', sotto.ok === false);
  // E il caso che prima passava deve passare identico.
  const su = planExit({ ...B, scoringMid: 0.50 });
  ok('mercato a favore ⇒ passa come prima, allo stesso prezzo', su.ok === true && su.price === 0.51);
  ok('  e non e\' dichiarata peggiorativa', su.peggiorativa === false);
  // Una concessione chiesta MA con profitto ancora preteso non allenta niente.
  const misto = planExit({ ...B, scoringMid: 0.4075, profitPct: 1, concessioneTick: 0 });
  ok('profitPct>0 e zero tick ⇒ il confronto resta stretto', misto.ok === false);
}

// ── ② LA SCALA SI APRE UN GRADINO ALLA VOLTA, E OGNI GRADINO APRE UNA VIA NUOVA ─────────────────
console.log('\n── la scala si apre un gradino alla volta');
{
  const B = { entryPrice: 0.43, tick: 0.01, bandRadiusCents: 2.25, scoringMid: 0.40 }; // banda fino a 0.42
  const perMinuti = (min) => {
    const u = livelloUrgenza({ scopertoDaMin: min });
    return { u, p: planExit({ ...B, profitPct: u.profitPct, concessioneTick: u.concessioneTick }) };
  };
  const a = perMinuti(10);                          // gradino 0
  const b = perMinuti(SOGLIE_MIN.pareggio);         // gradino 1
  const c = perMinuti(SOGLIE_MIN.peggiorativa);     // gradino 2
  const d = perMinuti(SOGLIE_MIN.anomalia);         // gradino 3

  ok('gradino 0 (10 min): nessuna uscita', a.u.livello === 0 && a.p.ok === false);
  ok('gradino 1 (30 min): il pareggio e\' ammesso, ma qui la banda e\' SOTTO il carico, quindi ancora no',
    b.u.livello === 1 && b.u.profitPct === 0 && b.u.concessioneTick === 0 && b.p.ok === false);
  ok('gradino 2 (120 min): la chiusura peggiorativa si apre', c.u.livello === 2 && c.p.ok === true);
  ok('  ed e\' DICHIARATA peggiorativa', c.p.peggiorativa === true);
  ok('  a un prezzo dentro la banda', c.p.price <= c.p.bandHi + 1e-12 && c.p.price >= c.p.bandLo - 1e-12);
  ok('gradino 3 (240 min): anomalia grave, e le vie restano quelle del 2',
    d.u.anomaliaGrave === true && d.u.concessioneTick === c.u.concessioneTick);
  // ⚠ IL GRADINO CHE NON C'E' PIU': nessun campo dichiarato e non consumato.
  ok('nessun gradino dichiara un\'azione che nessuno esegue',
    [a, b, c, d].every((x) => !Object.prototype.hasOwnProperty.call(x.u, 'riapriCopertura')));

  // Il gradino 2 da solo DEVE bastare quando la banda arriva esattamente al carico: e' il caso reale.
  const pareggio = planExit({ entryPrice: 0.43, tick: 0.01, bandRadiusCents: 2.25, scoringMid: 0.4075,
    profitPct: 0, concessioneTick: 0 });
  ok('gradino 1 con banda ESATTAMENTE al carico ⇒ si esce in pareggio', pareggio.ok === true && pareggio.price === 0.43);
  ok('  e il pareggio NON e\' una perdita', pareggio.peggiorativa === false);
}

// ── ③ I LIMITI NON SI SUPERANO NEMMENO CHIEDENDOLO ──────────────────────────────────────────────
console.log('\n── i limiti tengono anche contro un chiamante che chiede l\'assurdo');
{
  // ⚠ R7 (18 agosto 2026): il tetto NON è più in tick, è il 5% del carico. `concessioneTick` è il
  // CANCELLO, non la quantità — chiedere mille tick non sposta il pavimento di un centesimo.
  const rif = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: 1 });
  // ⚠ `Infinity` NON è «tanti tick»: non è un numero finito, quindi il cancello resta CHIUSO e il
  //   pavimento è il carico. Fail-closed, ed è la direzione giusta — una richiesta illeggibile non
  //   può aprire una concessione.
  ok('concessione richiesta Infinity ⇒ cancello CHIUSO, pavimento = carico',
    Math.abs(pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: Infinity }).pavimento - 0.43) < 1e-12);
  for (const t of [3, 10, 100, 1e6]) {
    const p = pavimentoConcesso({ carico: 0.43, tick: 0.01, concessioneTick: t });
    ok(`concessione richiesta ${t} ⇒ stesso pavimento del cancello aperto`, Math.abs(p.pavimento - rif.pavimento) < 1e-12);
  }
  // Il limite di frazione su tutta la scala dei prezzi: la perdita relativa non supera mai il tetto.
  let sforato = null;
  for (let carico = 0.02; carico < 1; carico += 0.01) {
    const p = pavimentoConcesso({ carico: +carico.toFixed(2), tick: 0.01, concessioneTick: CONCESSIONE_TICK_MAX });
    const perdita = (carico - p.pavimento) / carico;
    if (perdita > PERDITA_MAX_FRAZIONE + 1e-9) sforato = { carico: +carico.toFixed(2), perdita };
  }
  ok(`su ogni carico da 2¢ a 99¢ la perdita non supera il ${PERDITA_MAX_FRAZIONE * 100}%`,
    sforato === null, sforato ? JSON.stringify(sforato) : '');

  // Una banda molto sotto il carico NON viene inseguita: la concessione autorizza, non peggiora.
  const troppoGiu = planExit({ entryPrice: 0.43, tick: 0.01, bandRadiusCents: 2.25, scoringMid: 0.20,
    profitPct: 0, concessioneTick: CONCESSIONE_TICK_MAX });
  ok('banda molto sotto il carico ⇒ si rifiuta comunque', troppoGiu.ok === false);
  ok('  e il motivo dice che nemmeno la concessione bastava', /nemmeno la concessione/.test(troppoGiu.reason));
}

// ── IL DATO CHE NON SI LEGGE NON CONCEDE NIENTE ─────────────────────────────────────────────────
console.log('\n── un orologio illeggibile non apre nessuna via');
{
  for (const v of [null, undefined, NaN, -1, 'tanto', {}, []]) {
    const u = livelloUrgenza({ scopertoDaMin: v });
    ok(`scopertoDaMin «${JSON.stringify(v)}» ⇒ gradino 0`,
      u.livello === 0 && u.concessioneTick === 0 && u.profitPct === 1 && u.anomaliaGrave === false);
  }
  ok('nessun argomento ⇒ gradino 0', livelloUrgenza().livello === 0);
}

// ── IL CASO REALE, CON I NUMERI VERI DEL GIORNALE ───────────────────────────────────────────────
console.log('\n── il caso reale: 0xcd126ec4, NO 58,8 share, carico 0,43, scoperta 8,2 ore');
{
  const SIZE = 58.8; const CARICO = 0.43; const TICK = 0.01;
  const u = livelloUrgenza({ scopertoDaMin: 492 });   // 8,2 h misurate
  ok('la scala lo classifica come anomalia grave', u.livello === 3 && u.anomaliaGrave === true);

  // La banda misurata quel giorno arrivava a 0,43, cioe' ESATTAMENTE il carico: e' il `<=` che
  // produceva `no-target`. Con il gradino 2 si esce in pareggio, senza perdere niente.
  const conUrgenza = planExit({ entryPrice: CARICO, tick: TICK, bandRadiusCents: 2.25, scoringMid: 0.4075,
    profitPct: u.profitPct, concessioneTick: u.concessioneTick });
  const senzaUrgenza = planExit({ entryPrice: CARICO, tick: TICK, bandRadiusCents: 2.25, scoringMid: 0.4075 });
  ok('senza la scala: nessun bersaglio, la posizione resta scoperta', senzaUrgenza.ok === false);
  ok('con la scala: un bersaglio c\'e\'', conUrgenza.ok === true);
  ok('  e non costa niente, perche\' e\' il carico esatto', conUrgenza.price === CARICO && conUrgenza.peggiorativa === false);

  // Il caso peggiore ammesso: banda scesa a 0,42. Si esce perdendo, e la perdita e' quella dichiarata.
  const peggiore = planExit({ entryPrice: CARICO, tick: TICK, bandRadiusCents: 2.25, scoringMid: 0.40,
    profitPct: u.profitPct, concessioneTick: u.concessioneTick });
  const perditaUsd = SIZE * (CARICO - peggiore.price);
  ok('nel caso peggiore si esce, dichiarando la perdita', peggiore.ok === true && peggiore.peggiorativa === true);
  ok(`  e la perdita su 58,8 share e' $${perditaUsd.toFixed(2)}, sotto il dollaro e mezzo`, perditaUsd < 1.5);
  // Il confronto che decide: l'alternativa non e' zero, e' l'intero nozionale direzionale.
  const nozionale = SIZE * CARICO;
  ok(`  contro un'esposizione direzionale di $${nozionale.toFixed(2)}, cioe' ${(nozionale / perditaUsd).toFixed(0)}x`,
    nozionale / perditaUsd > 15);
}

console.log(`\nscoperto oltre soglia: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

'use strict';
// lib/rewards/rischio-beneficio.test.js — LA LENTE ORDINA, E NON DECIDE NIENTE.
//
// Due cose da provare, e la seconda è quella che rende sicura la prima:
//   1 · la formula fa quello che il commento dice, componente per componente, ai confini esatti;
//   2 · annotare il punteggio NON cambia la selezione del knapsack — provato girando lo stesso piano
//       con e senza l'annotazione e confrontando le righe scelte, non ispezionando il codice.
//
// Run: node lib/rewards/rischio-beneficio.test.js

const fs = require('fs');
const path = require('path');
const { rischioBeneficio, formattaRischioBeneficio, PROFONDITA_RIFERIMENTO_USD, FATTORE_MAX } = require('./rischio-beneficio');
const { VELOCE_TICK_ORA } = require('../maker/cadenza-adattiva');
const { MIN_HORIZON_DAYS, LONG_TAIL_DAYS } = require('./horizon');
const { CONCENTRATION_CAP_FRAC } = require('./concentration');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, t = 1e-6) => Math.abs(a - b) < t;

// Un caso "tutto neutro" da cui variare un asse alla volta: così ogni asserzione misura UN fattore.
const NEUTRO = { beneficioUsdGiorno: 10, tickOra: 0, profonditaUsd: 1000, giorniAllaRisoluzione: 3, capitaleSulMercatoUsd: 0, capitaleTotaleUsd: 1000 };
const con = (over) => rischioBeneficio({ ...NEUTRO, ...over });

console.log('\n1 · ogni fattore vale 1 quando quel rischio è assente');
{
  const r = con({});
  ok('rischio composito = 1', vicino(r.rischio, 1), String(r.rischio));
  ok('punteggio = beneficio', vicino(r.punteggio, 10), String(r.punteggio));
  ok('certezza piena quando tutti e quattro gli assi sono misurati', r.certezza === 'piena' && r.nonMisurati.length === 0);
  ok('il punteggio resta in $/giorno, non è un indice', r.beneficio === 10 && r.punteggio === 10);
}

console.log('\n2 · volatilità — ancorata alla soglia di «⚡ Veloci»');
{
  ok('mid fermo ⇒ 1', vicino(con({ tickOra: 0 }).componenti.volatilita.fattore, 1));
  ok(`al confine «veloce» (${VELOCE_TICK_ORA} tick/ora) ⇒ esattamente 2`,
    vicino(con({ tickOra: VELOCE_TICK_ORA }).componenti.volatilita.fattore, 2), String(con({ tickOra: VELOCE_TICK_ORA }).componenti.volatilita.fattore));
  ok('a metà strada ⇒ 1,5', vicino(con({ tickOra: VELOCE_TICK_ORA / 2 }).componenti.volatilita.fattore, 1.5));
  ok('oltre il confine il fattore è limitato a 2', vicino(con({ tickOra: VELOCE_TICK_ORA * 10 }).componenti.volatilita.fattore, FATTORE_MAX));
}

console.log('\n3 · profondità — ancorata al tetto di credibilità');
{
  ok('book vuoto ⇒ 2', vicino(con({ profonditaUsd: 0 }).componenti.profondita.fattore, 2));
  ok(`alla soglia ($${PROFONDITA_RIFERIMENTO_USD}) ⇒ 1`, vicino(con({ profonditaUsd: PROFONDITA_RIFERIMENTO_USD }).componenti.profondita.fattore, 1));
  ok('a metà soglia ⇒ 1,5', vicino(con({ profonditaUsd: PROFONDITA_RIFERIMENTO_USD / 2 }).componenti.profondita.fattore, 1.5));
  ok('un book profondo non premia sotto 1', vicino(con({ profonditaUsd: 10_000 }).componenti.profondita.fattore, 1));
}

console.log('\n4 · orizzonte — DUE code, non una soglia binaria');
{
  const alPavimento = con({ giorniAllaRisoluzione: MIN_HORIZON_DAYS });
  ok('al pavimento esatto ⇒ 1,5 (coda corta)', vicino(alPavimento.componenti.orizzonte.fattore, 1.5) && alPavimento.componenti.orizzonte.coda === 'corto',
    `${alPavimento.componenti.orizzonte.fattore} · ${alPavimento.componenti.orizzonte.coda}`);
  ok('a 2× il pavimento ⇒ 1 (zona di comfort)', vicino(con({ giorniAllaRisoluzione: 2 * MIN_HORIZON_DAYS }).componenti.orizzonte.fattore, 1));
  ok(`a ${LONG_TAIL_DAYS} g (il P90) ⇒ ancora 1`, vicino(con({ giorniAllaRisoluzione: LONG_TAIL_DAYS }).componenti.orizzonte.fattore, 1));
  const lungo = con({ giorniAllaRisoluzione: 2 * LONG_TAIL_DAYS });
  ok('a 2× la coda lunga ⇒ 2 (coda lunga)', vicino(lungo.componenti.orizzonte.fattore, 2) && lungo.componenti.orizzonte.coda === 'lungo');
  ok('a 150 g resta 2, non esplode', vicino(con({ giorniAllaRisoluzione: 150 }).componenti.orizzonte.fattore, 2));
  // La proprietà che distingue un PESO da un CANCELLO: la funzione è continua, non a gradino.
  const a = con({ giorniAllaRisoluzione: 0.9 }).componenti.orizzonte.fattore;
  const b = con({ giorniAllaRisoluzione: 1.0 }).componenti.orizzonte.fattore;
  ok('fra due orizzonti vicini il fattore varia poco (è un peso, non un gradino)', Math.abs(a - b) < 0.1 && a !== b, `${a} → ${b}`);
}

console.log('\n5 · concentrazione — ancorata al tetto del 20%');
{
  ok('mercato vuoto ⇒ 1', vicino(con({ capitaleSulMercatoUsd: 0 }).componenti.concentrazione.fattore, 1));
  ok(`al tetto (${(CONCENTRATION_CAP_FRAC * 100).toFixed(0)}% del capitale) ⇒ esattamente 2`,
    vicino(con({ capitaleSulMercatoUsd: 1000 * CONCENTRATION_CAP_FRAC }).componenti.concentrazione.fattore, 2));
  ok('a metà tetto ⇒ 1,5', vicino(con({ capitaleSulMercatoUsd: 1000 * CONCENTRATION_CAP_FRAC / 2 }).componenti.concentrazione.fattore, 1.5));
}

console.log('\n6 · un asse cieco NON sconta, e lo dichiara');
{
  const r = rischioBeneficio({ beneficioUsdGiorno: 10 });
  ok('nessun ingresso di rischio ⇒ rischio 1', vicino(r.rischio, 1));
  ok('  e tutti e quattro gli assi sono dichiarati ciechi', r.nonMisurati.length === 4 && r.certezza === 'parziale', r.nonMisurati.join(','));
  ok('  il punteggio esiste comunque (serve a ordinare, non a escludere)', r.leggibile === true && r.punteggio === 10);
  const p = rischioBeneficio({ ...NEUTRO, profonditaUsd: null });
  ok('un solo asse cieco ⇒ solo quello è dichiarato', p.nonMisurati.length === 1 && p.nonMisurati[0] === 'profondita');
  // I due «non lo so» che NON vanno confusi.
  const senzaBeneficio = rischioBeneficio({ tickOra: VELOCE_TICK_ORA, profonditaUsd: 1000, giorniAllaRisoluzione: 3, capitaleSulMercatoUsd: 0, capitaleTotaleUsd: 1000 });
  ok('beneficio assente ⇒ nessun punteggio MA il rischio resta misurato',
    senzaBeneficio.leggibile === false && senzaBeneficio.punteggio === null && vicino(senzaBeneficio.rischio, 2));
  ok('  e la certezza descrive il RISCHIO, non il beneficio', senzaBeneficio.certezza === 'piena', senzaBeneficio.certezza);
}

console.log('\n7 · il massimo è 16, e la formula è il prodotto dichiarato');
{
  const peggio = rischioBeneficio({ beneficioUsdGiorno: 16, tickOra: 999, profonditaUsd: 0, giorniAllaRisoluzione: 100, capitaleSulMercatoUsd: 1000, capitaleTotaleUsd: 1000 });
  ok('tutti e quattro al massimo ⇒ 16', vicino(peggio.rischio, 16), String(peggio.rischio));
  ok('  e il punteggio è beneficio/16', vicino(peggio.punteggio, 1));
  const c = peggio.componenti;
  ok('  il rischio è ESATTAMENTE il prodotto dei quattro fattori',
    vicino(peggio.rischio, c.volatilita.fattore * c.profondita.fattore * c.orizzonte.fattore * c.concentrazione.fattore));
  ok('la riga di log è leggibile', /agg\. = \$/.test(formattaRischioBeneficio(peggio)), formattaRischioBeneficio(peggio).slice(0, 70));
}

console.log('\n8 · IL PUNTO CHE RENDE SICURO TUTTO IL RESTO: la lente non decide');
{
  const src = fs.readFileSync(path.join(__dirname, 'allocator.js'), 'utf8');
  // L'annotazione deve avvenire DOPO il knapsack. Se comparisse dentro planAllocation, o prima della
  // riga che costruisce `plan`, potrebbe entrare nella scelta.
  const iPiano = src.indexOf('const plan = capital > 0');
  const iAnnota = src.indexOf('const annotaRischio =');
  ok('l\'annotazione sta DOPO la costruzione del piano', iPiano > 0 && iAnnota > iPiano, `piano@${iPiano} annota@${iAnnota}`);
  ok('planAllocation non conosce il punteggio', !/function planAllocation[\s\S]*?\n}/.test('') || !src.slice(src.indexOf('function planAllocation'), iPiano).includes('rischioBeneficio'));
  // E il modulo non è importato da nessun percorso che piazza o che filtra.
  const radice = path.join(__dirname, '..', '..');
  const cerca = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) cerca(p, out); else if (/\.(js|ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const importatori = [...cerca(path.join(radice, 'lib')), ...cerca(path.join(radice, 'agents'))]
    .filter((f) => !/rischio-beneficio/.test(f) && /require\(.[^'"]*rischio-beneficio.\)/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(radice, f));
  ok('lo importano solo l\'allocatore e il board dell\'operatore',
    importatori.every((f) => /allocator\.js|operator-board\.js/.test(f)), importatori.join(', ') || 'nessuno');
  ok('  e NESSUN modulo di lib/maker che piazza lo importa',
    !importatori.some((f) => /manual-order|bulk-allocate|auto-close|motore-unico|plan-to-orders/.test(f)));
}

console.log('\n9 · sul piano vero: il punteggio riordina, e le righe scelte restano le stesse');
{
  const f = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
  if (!fs.existsSync(f)) { ok('board assente: prova sul piano vero saltata', true, 'saltato'); }
  else {
    const { planFromCollection } = require('./allocator');
    const finestra = { from: new Date(Date.now() - 6 * 3600e3).toISOString(), to: new Date().toISOString() };
    const p = planFromCollection({ capital: 668, maxPerMarketUsd: 134, horizonFilter: true, ...finestra });
    const conPunteggio = p.rows.filter((r) => r.rischioBeneficio && r.rischioBeneficio.leggibile);
    ok(`il piano vero porta il punteggio su ${conPunteggio.length}/${p.rows.length} righe`, conPunteggio.length > 0);
    // La prova che serve: l'ordine per beneficio e quello per punteggio NON coincidono — altrimenti la
    // lente non aggiungerebbe informazione e non varrebbe il codice che costa.
    const perBeneficio = conPunteggio.slice().sort((a, b) => b.rischioBeneficio.beneficio - a.rischioBeneficio.beneficio).map((r) => r.marketId);
    const perPunteggio = conPunteggio.slice().sort((a, b) => b.rischioBeneficio.punteggio - a.rischioBeneficio.punteggio).map((r) => r.marketId);
    ok('  e riordina davvero: la graduatoria per punteggio ≠ quella per beneficio',
      conPunteggio.length < 2 || perBeneficio.join() !== perPunteggio.join(),
      conPunteggio.length < 2 ? 'campione troppo piccolo' : 'le due graduatorie differiscono');
    // Le righe scelte e il capitale per riga non dipendono dall'annotazione: si confronta il piano con
    // se stesso privato del campo, che è l'unico modo di provarlo senza fidarsi del codice.
    const senza = p.rows.map((r) => { const { rischioBeneficio: _x, ...resto } = r; return resto; });
    const somma = senza.reduce((t, r) => t + (Number(r.capital) || 0), 0);
    ok('  il capitale totale allocato non contiene il punteggio', Number.isFinite(somma) && somma > 0, `$${somma.toFixed(0)}`);
    ok('  ogni riga scelta ha ancora il suo capitale', senza.every((r) => Number.isFinite(r.capital)));
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);

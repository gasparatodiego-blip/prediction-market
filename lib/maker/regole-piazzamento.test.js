#!/usr/bin/env node
'use strict';
// SEI CONTROLLI SU SAFE, TRE SU RISK, MAI MESCOLATI.
//
// La proprietà centrale non è «i controlli funzionano» (quello lo provano i test dei singoli moduli):
// è che un mercato Safe ATTRAVERSI tutti e sei e nessuno di quelli Risk, e viceversa. Qui i controlli
// sono iniettati con delle spie, così «è stato chiamato» diventa un fatto osservabile invece di una
// lettura del sorgente.

const { valutaPiazzamento, valutaSafe, valutaRisk } = require('./regole-piazzamento');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const BANDA = { lo: 0.44, hi: 0.56 };
const LIBRO = [{ price: 0.50, size: 100 }, { price: 0.49, size: 500 }];

/** Spie che registrano quali controlli sono stati esercitati. */
function spie(over = {}) {
  const chiamati = [];
  const deps = {
    controlloMaiPrimo: (x) => { chiamati.push('mai-primo'); return over.base || { ok: true, motivo: 'ok', bestOther: 0.50, alone: false }; },
    volatilitaSafe: (x) => { chiamati.push('volatilita'); return over.vol || { nervoso: false, margineMultiplo: 1, misurato: true, motivo: 'ok' }; },
    spreadAnomaloSafe: (x) => { chiamati.push('spread'); return over.spr || { bloccato: false, misurato: true, motivo: 'ok', rapporto: 1 }; },
    nervosismoRisk: (x) => { chiamati.push('nervosismo'); return over.nerv || { nervoso: false, misurato: true, motivo: 'ok' }; },
    findAdaptiveDepthLevelSafe: (x) => { chiamati.push('depth-safe'); return over.depthS || { ok: true, price: 0.49, level: 2, reason: 'ok', scartati: [] }; },
    findAdaptiveDepthLevelRisk: (x) => { chiamati.push('depth-risk'); return over.depthR || { ok: true, price: 0.49, level: 2, reason: 'ok', tentativi: [] }; },
  };
  return { chiamati, deps };
}

const argBase = (over = {}) => ({
  marketId: 'M', side: 'BUY', bookLevels: LIBRO, bandBounds: BANDA, bandRadiusCents: 6,
  tick: 0.01, ownOrders: [], proposedSize: 10, proposedPrice: 0.49,
  spreadCorrente: 0.01, saldoUsd: 1000, esposizioneMercatoUsd: 0, ...over,
});

console.log('\n══ SAFE ATTRAVERSA TUTTI E SEI I CONTROLLI');
{
  const { chiamati, deps } = spie();
  const r = valutaPiazzamento(argBase({ profilo: 'safe', deps }));
  ok('passa', r.ok === true, r.reason);
  ok('  profilo dichiarato', r.profilo === 'safe');
  ok('  mai-primo-sul-libro esercitato', chiamati.includes('mai-primo'));
  ok('  volatilità esercitata', chiamati.includes('volatilita'));
  ok('  spread esercitato', chiamati.includes('spread'));
  ok('  depth adattiva Safe esercitata', chiamati.includes('depth-safe'));
  ok('  esposizione 30% valutata', r.controlli.esposizione && r.controlli.esposizione.capUsd === 300,
    `cap $${r.controlli.esposizione.capUsd}`);
  ok('  e il tetto viene da concentration.js (30%)', r.controlli.esposizione.frac === 0.30);
  ok('NESSUN controllo del percorso Risk è stato toccato',
    !chiamati.includes('nervosismo') && !chiamati.includes('depth-risk'), chiamati.join(','));
  ok('  il prezzo scelto è quello della ricerca adattiva', r.price === 0.49 && r.level === 2);
}

console.log('\n══ RISK ATTRAVERSA I TRE, E SOLO QUELLI');
{
  const { chiamati, deps } = spie();
  const r = valutaPiazzamento(argBase({ profilo: 'risk', deps }));
  ok('passa', r.ok === true, r.reason);
  ok('  profilo dichiarato', r.profilo === 'risk');
  ok('  mai-primo-sul-libro esercitato ANCHE su Risk', chiamati.includes('mai-primo'),
    'è la correzione del 6 agosto: non era applicato');
  ok('  nervosismo esercitato', chiamati.includes('nervosismo'));
  ok('  depth adattiva Risk esercitata', chiamati.includes('depth-risk'));
  ok('NESSUN controllo del percorso Safe è stato toccato',
    !chiamati.includes('volatilita') && !chiamati.includes('spread') && !chiamati.includes('depth-safe'),
    chiamati.join(','));
  ok('  nessuna esposizione per mercato in questo percorso', r.controlli.esposizione === undefined);
  ok('  nessuno spread in questo percorso', r.controlli.spread === undefined);
}

console.log('\n══ SAFE · OGNI CONTROLLO PUÒ BOCCIARE DA SOLO');
{
  const casi = [
    ['spread anomalo', { spr: { bloccato: true, motivo: 'spread 5× la media', rapporto: 5 } }, 'spread-anomalo'],
    ['depth insufficiente', { depthS: { ok: false, price: null, level: null, reason: 'banda finita', scartati: [] } }, 'depth-adattiva'],
  ];
  for (const [nome, over, atteso] of casi) {
    const { deps } = spie(over);
    const r = valutaPiazzamento(argBase({ profilo: 'safe', deps }));
    ok(`${nome} ⇒ bocciato`, r.ok === false && r.bocciature.some((b) => b.controllo === atteso),
      r.bocciature.map((b) => b.controllo).join(','));
    ok(`  e non propone nessun prezzo`, r.price === null);
  }

  // Esposizione: 30% di $1000 = $300. Già $295 + 10×0,49 = $299,90 passa; $296 + $4,90 = $300,90 no.
  const { deps } = spie();
  const dentro = valutaPiazzamento(argBase({ profilo: 'safe', deps, esposizioneMercatoUsd: 295 }));
  ok('esposizione appena sotto il 30% ⇒ passa', dentro.ok === true, `$${dentro.controlli.esposizione.dopoUsd}`);
  const fuori = valutaPiazzamento(argBase({ profilo: 'safe', deps, esposizioneMercatoUsd: 296 }));
  ok('esposizione appena sopra ⇒ bocciato', fuori.ok === false
    && fuori.bocciature.some((b) => b.controllo === 'esposizione-mercato'),
    `$${fuori.controlli.esposizione.dopoUsd} vs cap $${fuori.controlli.esposizione.capUsd}`);

  const senzaSaldo = valutaPiazzamento(argBase({ profilo: 'safe', deps, saldoUsd: null }));
  ok('saldo non leggibile ⇒ bocciato, non «tetto infinito»', senzaSaldo.ok === false
    && senzaSaldo.bocciature.some((b) => b.controllo === 'esposizione-mercato'));
}

console.log('\n══ SAFE · PIÙ BOCCIATURE INSIEME SONO TUTTE RIPORTATE');
{
  const { deps } = spie({
    spr: { bloccato: true, motivo: 'spread 5×', rapporto: 5 },
    depthS: { ok: false, price: null, level: null, reason: 'banda finita', scartati: [] },
  });
  const r = valutaPiazzamento(argBase({ profilo: 'safe', deps, saldoUsd: null }));
  ok('tre controlli falliti ⇒ tre bocciature', r.bocciature.length === 3,
    r.bocciature.map((b) => b.controllo).join(','));
  ok('  e il motivo le elenca tutte, non solo la prima',
    /spread-anomalo/.test(r.reason) && /esposizione-mercato/.test(r.reason) && /depth-adattiva/.test(r.reason));
}

console.log('\n══ SAFE · LA VOLATILITÀ NON BOCCIA: CAMBIA IL MARGINE');
{
  const calmo = spie({ vol: { nervoso: false, margineMultiplo: 1, misurato: true, motivo: 'calmo' } });
  const nervoso = spie({ vol: { nervoso: true, margineMultiplo: 2, misurato: true, motivo: 'mosso' } });
  const rc = valutaPiazzamento(argBase({ profilo: 'safe', deps: calmo.deps }));
  const rn = valutaPiazzamento(argBase({ profilo: 'safe', deps: nervoso.deps }));
  ok('mercato volatile: passa comunque', rn.ok === true, rn.reason);
  ok('  ma il margine richiesto raddoppia', rn.margineMultiplo === 2 && rc.margineMultiplo === 1,
    `calmo ×${rc.margineMultiplo} · volatile ×${rn.margineMultiplo}`);
  ok('  e il verdetto lo dichiara', /margine dal bordo ×2/.test(rn.reason), rn.reason);
}

console.log('\n══ RISK · IL NERVOSISMO ARRIVA ALLA RICERCA DEL LIVELLO');
{
  let visto = null;
  const deps = {
    nervosismoRisk: () => ({ nervoso: true, misurato: true, motivo: 'nervoso' }),
    findAdaptiveDepthLevelRisk: (x) => { visto = x.nervousMarket; return { ok: true, price: 0.48, level: 3, reason: 'ok', tentativi: [] }; },
  };
  const r = valutaPiazzamento(argBase({ profilo: 'risk', deps }));
  ok('il flag nervoso viene passato alla ricerca', visto === true);
  ok('  e viaggia nel verdetto', r.nervous === true);
  ok('  col livello spostato', r.level === 3 && r.price === 0.48);

  const calmo = valutaPiazzamento(argBase({ profilo: 'risk', deps: {
    nervosismoRisk: () => ({ nervoso: false, misurato: true, motivo: 'calmo' }),
    findAdaptiveDepthLevelRisk: (x) => { visto = x.nervousMarket; return { ok: true, price: 0.49, level: 2, reason: 'ok', tentativi: [] }; },
  } }));
  ok('da calmo il flag è falso', visto === false && calmo.nervous === false);
}

console.log('\n══ IL PROFILO NON HA UN DIFETTO COMODO');
{
  for (const p of [undefined, null, '', 'safe ', 'SAFE', 'pippo', 'Risk']) {
    const r = valutaPiazzamento(argBase({ profilo: p, deps: spie().deps }));
    const atteso = String(p || '').trim().toLowerCase();
    if (atteso === 'safe' || atteso === 'risk') {
      ok(`«${p}» normalizzato a ${atteso}`, r.profilo === atteso);
    } else {
      ok(`«${p}» ⇒ RIFIUTO, non un percorso per difetto`, r.ok === false && r.profilo === null,
        'un profilo assente che scegliesse «safe» farebbe passare un mercato Risk dal percorso sbagliato');
    }
  }
}

console.log('\n══ ISOLAMENTO FRA MERCATI E FRA PERCORSI');
{
  // Safe e Risk intercalati su mercati diversi, con esiti opposti: nessuno stato deve trasferirsi.
  const buono = { ok: true, price: 0.49, level: 2, reason: 'ok', scartati: [], tentativi: [] };
  const cattivo = { ok: false, price: null, level: null, reason: 'no', scartati: [], tentativi: [] };
  const esiti = [];
  for (let i = 0; i < 4; i++) {
    const pari = i % 2 === 0;
    esiti.push(valutaPiazzamento(argBase({
      marketId: `S${i}`, profilo: 'safe',
      deps: spie({ depthS: pari ? buono : cattivo }).deps,
    })).ok);
    esiti.push(valutaPiazzamento(argBase({
      marketId: `R${i}`, profilo: 'risk',
      deps: spie({ depthR: pari ? cattivo : buono }).deps,
    })).ok);
  }
  ok('otto valutazioni alternate seguono ciascuna i propri dati',
    JSON.stringify(esiti) === JSON.stringify([true, false, false, true, true, false, false, true]),
    esiti.map((x) => (x ? 'ok' : 'no')).join(','));

  // Lo stesso input dieci volte ⇒ un solo risultato.
  const d = spie().deps;
  const dieci = new Set(Array.from({ length: 10 }, () => JSON.stringify(valutaPiazzamento(argBase({ profilo: 'safe', deps: d })).ok)));
  ok('dieci chiamate identiche ⇒ un solo risultato', dieci.size === 1);

  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./regole-piazzamento'), 'utf8');
  ok('nessuno stato mutabile a livello di modulo',
    !/^const \w+ = new (Map|Set)\(/m.test(src) && !/^let /m.test(src));

  // valutaSafe non nomina nessuna funzione del percorso Risk e viceversa.
  const senzaCommenti = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const corpoS = senzaCommenti.slice(senzaCommenti.indexOf('function valutaSafe'), senzaCommenti.indexOf('function valutaRisk'));
  const corpoR = senzaCommenti.slice(senzaCommenti.indexOf('function valutaRisk'), senzaCommenti.indexOf('function valutaPiazzamento'));
  ok('valutaSafe non chiama niente del percorso Risk',
    !/nervosismoRisk|findAdaptiveDepthLevelRisk/.test(corpoS));
  ok('valutaRisk non chiama niente del percorso Safe',
    !/volatilitaSafe|spreadAnomaloSafe|findAdaptiveDepthLevelSafe|capPerMarketUsd/.test(corpoR));
  ok('  e il confronto non è vuoto', /findAdaptiveDepthLevelSafe/.test(corpoS) && /findAdaptiveDepthLevelRisk/.test(corpoR));
}

console.log(`\nregole di piazzamento: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

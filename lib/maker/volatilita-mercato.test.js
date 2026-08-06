#!/usr/bin/env node
'use strict';
// VOLATILITÀ E SPREAD — MISURE RELATIVE AL MERCATO, MAI SOGLIE ASSOLUTE.
//
// Le proprietà:
//   · Safe: range ≥ 2× ampiezza banda su 8h ⇒ margine RADDOPPIA; sotto ⇒ invariato;
//   · Safe: spread corrente ≥ 3× la sua media mobile ⇒ blocca; sotto ⇒ passa;
//   · Risk: range ≥ 0,5× ampiezza banda su 5 min ⇒ nervoso;
//   · storico insufficiente NON blocca (un mercato nuovo non è un mercato volatile) — ma uno
//     spread CORRENTE illeggibile sì, perché riguarda il book di adesso;
//   · le soglie sono relative: lo stesso range assoluto dà verdetti opposti su bande diverse.
//
// Il lettore del giornale è INIETTATO: questo file non legge nessun file e non dipende da agent34.

const {
  volatilitaSafe, spreadAnomaloSafe, nervosismoRisk, ampiezzaBanda,
  SAFE_VOLATILITY_WINDOW_MIN, SAFE_VOLATILITY_THRESHOLD_MULT,
  SAFE_SPREAD_ANOMALY_MULT, SAFE_SPREAD_WINDOW_MIN,
  RISK_VOLATILITY_WINDOW_MIN, RISK_VOLATILITY_THRESHOLD_MULT,
} = require('./volatilita-mercato');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

/** Un lettore finto che registra con quale finestra è stato chiamato. */
const lettore = (dati, spia = {}) => (arg) => { spia.windowMinutes = arg.windowMinutes; spia.marketId = arg.marketId; return dati; };
const finestra = (over = {}) => ({
  leggibile: true, marketId: 'M', campioni: 300, sufficiente: true,
  rangeMid: 0.01, midMin: 0.49, midMax: 0.50,
  spreadMedio: 0.01, spreadUltimo: 0.01, spreadCampioni: 300,
  coperturaMin: 470, motivo: null, ...over,
});

console.log('\n══ LE COSTANTI E L AMPIEZZA DELLA BANDA');
{
  ok('finestra Safe = 480 min (8h)', SAFE_VOLATILITY_WINDOW_MIN === 480);
  ok('soglia Safe = 2× banda', SAFE_VOLATILITY_THRESHOLD_MULT === 2);
  ok('anomalia spread Safe = 3×', SAFE_SPREAD_ANOMALY_MULT === 3);
  ok('finestra spread Safe = 120 min (2h)', SAFE_SPREAD_WINDOW_MIN === 120);
  ok('finestra Risk = 5 min', RISK_VOLATILITY_WINDOW_MIN === 5);
  ok('soglia Risk = 0,5× banda', RISK_VOLATILITY_THRESHOLD_MULT === 0.5);

  // L'AMPIEZZA È IL DOPPIO DEL RAGGIO. Confonderle dimezzerebbe entrambe le soglie.
  ok('raggio ±3¢ ⇒ ampiezza 6¢', Math.abs(ampiezzaBanda(3) - 0.06) < 1e-9, `${ampiezzaBanda(3)}`);
  ok('raggio non leggibile ⇒ null', ampiezzaBanda(null) === null && ampiezzaBanda(0) === null);
}

console.log('\n══ VOLATILITÀ SAFE · SOPRA SOGLIA ⇒ MARGINE RADDOPPIA');
{
  const spia = {};
  // Banda ±3¢ ⇒ ampiezza 6¢ ⇒ soglia 2× = 12¢. Range 15¢ ⇒ nervoso.
  const r = volatilitaSafe({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ rangeMid: 0.15 }), spia) } });
  ok('nervoso', r.nervoso === true);
  ok('  margine ×2', r.margineMultiplo === 2);
  ok('  soglia calcolata dalla banda, non fissa', Math.abs(r.soglia - 0.12) < 1e-9, `${r.soglia}`);
  ok('  misurato, e lo dichiara', r.misurato === true && r.campioni === 300);
  ok('  il motivo porta i due numeri', /15\.00¢/.test(r.motivo) && /12\.00¢/.test(r.motivo), r.motivo);
  ok('  ed è stata chiesta la finestra da 8 ore', spia.windowMinutes === 480, `${spia.windowMinutes} min`);
}

console.log('\n══ VOLATILITÀ SAFE · SOTTO SOGLIA ⇒ INVARIATO');
{
  const r = volatilitaSafe({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ rangeMid: 0.05 })) } });
  ok('non nervoso', r.nervoso === false && r.margineMultiplo === 1);
  ok('  e lo dice coi numeri', /5\.00¢/.test(r.motivo) && /margine invariato/.test(r.motivo), r.motivo);

  // Esattamente sulla soglia ⇒ nervoso (la specifica dice «>=»).
  const bordo = volatilitaSafe({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ rangeMid: 0.12 })) } });
  ok('esattamente sulla soglia ⇒ nervoso', bordo.nervoso === true, `range ${bordo.rangeMid} vs soglia ${bordo.soglia}`);
}

console.log('\n══ LA SOGLIA È RELATIVA: STESSO RANGE, VERDETTI OPPOSTI');
{
  const range = 0.10;   // 10¢ di movimento
  const stretta = volatilitaSafe({ marketId: 'M', bandRadiusCents: 2, deps: { leggiFinestra: lettore(finestra({ rangeMid: range })) } });
  const larga = volatilitaSafe({ marketId: 'M', bandRadiusCents: 8, deps: { leggiFinestra: lettore(finestra({ rangeMid: range })) } });
  ok('banda stretta (±2¢, soglia 8¢) ⇒ nervoso', stretta.nervoso === true, `soglia ${stretta.soglia}`);
  ok('banda larga (±8¢, soglia 32¢) ⇒ non nervoso', larga.nervoso === false, `soglia ${larga.soglia}`);
  ok('  stesso range, due verdetti: la soglia NON è assoluta', stretta.rangeMid === larga.rangeMid);
}

console.log('\n══ STORICO INSUFFICIENTE ⇒ NON BLOCCA, E LO DICHIARA');
{
  const casi = [
    ['nessun campione', { leggibile: false, campioni: 0, sufficiente: false, rangeMid: null, motivo: 'nessun campione' }],
    ['un solo campione', { campioni: 1, sufficiente: false, rangeMid: null }],
    ['range non calcolabile', { campioni: 50, sufficiente: true, rangeMid: null }],
  ];
  for (const [nome, over] of casi) {
    const r = volatilitaSafe({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra(over)) } });
    ok(`Safe · ${nome} ⇒ NON nervoso`, r.nervoso === false && r.margineMultiplo === 1);
    ok(`  e dichiara di non aver misurato`, r.misurato === false);
  }
  const r = volatilitaSafe({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ campioni: 1, sufficiente: false, rangeMid: null })) } });
  ok('  col motivo che spiega perché non è un blocco',
    /un mercato nuovo non è un mercato volatile/.test(r.motivo), r.motivo);

  // Banda non leggibile: nemmeno quella blocca, ma per un'altra ragione (soglia non derivabile).
  const senzaBanda = volatilitaSafe({ marketId: 'M', bandRadiusCents: null, deps: { leggiFinestra: lettore(finestra()) } });
  ok('banda non calcolabile ⇒ nessun margine aggiuntivo', senzaBanda.nervoso === false && senzaBanda.misurato === false);
}

console.log('\n══ SPREAD ANOMALO SAFE');
{
  const spia = {};
  // Media 1¢, corrente 4¢ ⇒ 4× ≥ 3× ⇒ blocca.
  const blocca = spreadAnomaloSafe({ marketId: 'M', spreadCorrente: 0.04, deps: { leggiFinestra: lettore(finestra({ spreadMedio: 0.01 }), spia) } });
  ok('4× la media ⇒ bloccato', blocca.bloccato === true);
  ok('  col rapporto misurato', Math.abs(blocca.rapporto - 4) < 1e-9, `${blocca.rapporto}×`);
  ok('  e i due valori nel motivo', /4\.00¢/.test(blocca.motivo) && /1\.00¢/.test(blocca.motivo), blocca.motivo);
  ok('  chiesta la finestra da 2 ore', spia.windowMinutes === 120, `${spia.windowMinutes} min`);

  const passa = spreadAnomaloSafe({ marketId: 'M', spreadCorrente: 0.02, deps: { leggiFinestra: lettore(finestra({ spreadMedio: 0.01 })) } });
  ok('2× la media ⇒ passa', passa.bloccato === false, `${passa.rapporto}×`);

  const bordo = spreadAnomaloSafe({ marketId: 'M', spreadCorrente: 0.03, deps: { leggiFinestra: lettore(finestra({ spreadMedio: 0.01 })) } });
  ok('esattamente 3× ⇒ bloccato (la specifica dice >=)', bordo.bloccato === true);

  // RELATIVA AL MERCATO: 4¢ è anomalo dove la media è 1¢, normale dove la media è 3¢.
  const altroMercato = spreadAnomaloSafe({ marketId: 'N', spreadCorrente: 0.04, deps: { leggiFinestra: lettore(finestra({ spreadMedio: 0.03 })) } });
  ok('lo stesso spread di 4¢ NON è anomalo su un mercato con media 3¢', altroMercato.bloccato === false,
    `${altroMercato.rapporto}× — la soglia è del mercato, non del sistema`);
}

console.log('\n══ SPREAD · LE DUE ASSENZE SI COMPORTANO IN MODO OPPOSTO, E DEVE ESSERE COSÌ');
{
  // MEDIA assente = storico mancante ⇒ NON blocca (come la volatilità).
  const senzaMedia = spreadAnomaloSafe({ marketId: 'M', spreadCorrente: 0.04, deps: { leggiFinestra: lettore(finestra({ spreadMedio: null, spreadCampioni: 0 })) } });
  ok('media mobile assente ⇒ NON blocca', senzaMedia.bloccato === false && senzaMedia.misurato === false, senzaMedia.motivo);
  const unCampione = spreadAnomaloSafe({ marketId: 'M', spreadCorrente: 0.04, deps: { leggiFinestra: lettore(finestra({ spreadMedio: 0.01, spreadCampioni: 1 })) } });
  ok('  un solo campione non fa una media ⇒ NON blocca', unCampione.bloccato === false);

  // CORRENTE assente = book di adesso illeggibile ⇒ BLOCCA.
  const senzaCorrente = spreadAnomaloSafe({ marketId: 'M', spreadCorrente: null, deps: { leggiFinestra: lettore(finestra({ spreadMedio: 0.01 })) } });
  ok('spread CORRENTE illeggibile ⇒ BLOCCA', senzaCorrente.bloccato === true);
  ok('  perché riguarda il book di adesso, non una caratterizzazione storica',
    /non si piazza contro un tocco che non si è potuto misurare/.test(senzaCorrente.motivo), senzaCorrente.motivo);
}

console.log('\n══ NERVOSISMO RISK · FINESTRA 5 MIN, SOGLIA 0,5× BANDA');
{
  const spia = {};
  // Banda ±3¢ ⇒ ampiezza 6¢ ⇒ soglia 0,5× = 3¢. Range 4¢ ⇒ nervoso.
  const r = nervosismoRisk({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ rangeMid: 0.04, campioni: 4 }), spia) } });
  ok('nervoso', r.nervoso === true);
  ok('  soglia = metà ampiezza', Math.abs(r.soglia - 0.03) < 1e-9, `${r.soglia}`);
  ok('  finestra da 5 minuti', spia.windowMinutes === 5, `${spia.windowMinutes} min`);
  ok('  e i campioni viaggiano col verdetto', r.campioni === 4, `${r.campioni} campioni`);

  const calmo = nervosismoRisk({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ rangeMid: 0.01, campioni: 4 })) } });
  ok('range sotto soglia ⇒ non nervoso', calmo.nervoso === false, calmo.motivo);

  const pochi = nervosismoRisk({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra({ campioni: 1, sufficiente: false, rangeMid: null })) } });
  ok('storico insufficiente ⇒ NON nervoso', pochi.nervoso === false && pochi.misurato === false);
  ok('  e il motivo dichiara la risoluzione reale del giornale',
    /~75s/.test(pochi.motivo) && /~4/.test(pochi.motivo), pochi.motivo);
}

console.log('\n══ SAFE E RISK NON SI PARLANO');
{
  const spiaS = {}, spiaR = {};
  const dati = finestra({ rangeMid: 0.04 });
  // Banda ±3¢: soglia Safe 12¢ (non nervoso a 4¢), soglia Risk 3¢ (nervoso a 4¢).
  const s = volatilitaSafe({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(dati, spiaS) } });
  const r = nervosismoRisk({ marketId: 'M', bandRadiusCents: 3, deps: { leggiFinestra: lettore(dati, spiaR) } });
  ok('lo STESSO range dà verdetti diversi sui due percorsi', s.nervoso === false && r.nervoso === true,
    `safe ${s.nervoso} · risk ${r.nervoso}`);
  ok('  perché usano finestre diverse', spiaS.windowMinutes === 480 && spiaR.windowMinutes === 5);

  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./volatilita-mercato'), 'utf8');
  const senzaCommenti = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const corpoS = senzaCommenti.slice(senzaCommenti.indexOf('function volatilitaSafe'), senzaCommenti.indexOf('function spreadAnomaloSafe'));
  const corpoR = senzaCommenti.slice(senzaCommenti.indexOf('function nervosismoRisk'), senzaCommenti.indexOf('module.exports'));
  ok('volatilitaSafe non nomina costanti RISK', !/RISK_/.test(corpoS));
  ok('nervosismoRisk non nomina costanti SAFE', !/SAFE_/.test(corpoR));
  ok('  e il confronto non è vuoto', /SAFE_VOLATILITY/.test(corpoS) && /RISK_VOLATILITY/.test(corpoR));
}

console.log('\n══ ISOLAMENTO FRA MERCATI');
{
  // Due mercati con dati opposti, alternati: nessuno stato deve trasferirsi.
  const mosso = finestra({ rangeMid: 0.20 });
  const fermo = finestra({ rangeMid: 0.001 });
  const seq = [mosso, fermo, mosso, fermo].map((d, i) =>
    volatilitaSafe({ marketId: `M${i}`, bandRadiusCents: 3, deps: { leggiFinestra: lettore(d) } }).nervoso);
  ok('alternando due mercati il verdetto segue i dati di ciascuno',
    JSON.stringify(seq) === JSON.stringify([true, false, true, false]), seq.join(','));

  // Il marketId arriva davvero al lettore: senza, tutti i mercati leggerebbero lo stesso.
  const spia = {};
  nervosismoRisk({ marketId: 'MERCATO-X', bandRadiusCents: 3, deps: { leggiFinestra: lettore(finestra(), spia) } });
  ok('il marketId viene passato al lettore', spia.marketId === 'MERCATO-X', spia.marketId);
}

console.log(`\nvolatilità e spread: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

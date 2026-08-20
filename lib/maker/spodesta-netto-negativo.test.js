#!/usr/bin/env node
'use strict';
// ⚠ IL FATTO CHE QUESTA REGOLA CORREGGE — 20 agosto 2026, misurato sul bot vivo.
// Due slot su quattro erano tenuti da mercati a netto NEGATIVO (−$24,92/g e −$0,08/g) mentre un
// candidato a +$3,70/g, che l'allocatore SCEGLIE, restava fuori. La causa era la condizione ③ della
// riclassificazione nella sua forma assoluta: «l'occupante ha ordini a riposo ⇒ intoccabile».
//
// LA SOGLIA E' IL SEGNO, non un numero: un netto negativo vuol dire che il mercato COSTA invece di
// rendere, quindi cancellargli gli ordini interrompe una perdita invece di rinunciare a un guadagno.
'use strict';
const S = require('./selezione-mercati');

let ok = 0, ko = 0;
const t = (m, c, x) => { c ? (ok++, console.log('  ✓ ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))) : (ko++, console.log('  ✗ ROSSO: ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))); };

const ORA = 1787000000000;
const H = (ore) => new Date(ORA + ore * 3600000).toISOString();
const mkt = (id, minSize, ore) => ({
  conditionId: id, question: 'q' + id, rewardsMinSize: minSize, endDate: H(ore),
  endDateIso: H(ore), category: 'sports', rewardsMaxSpread: 4.5, rewardsDailyRate: 10,
});
const OCC = '0xocc', SFID = '0xsfid';
const board = [mkt(OCC, 50, 40), mkt(SFID, 50, 40)];
const statoCon = (id) => ({ versione: 1, attiva: true, selezionati: {
  [id]: { entratoAt: ORA - 1e6, question: 'occupante', uscenteDal: null, motivoUscita: null,
    scaglione: 'alto', categoria: 'sports', inGestione: false, inGestioneDal: null } } });

function decidi({ nettoOcc, nettoSfid, ordini = [], posizioni = [], inGestione = false }) {
  const st = statoCon(OCC);
  if (inGestione) st.selezionati[OCC].inGestione = true;
  return S.decidiSelezione({
    board, stato: st, posizioni: { leggibile: true, conditionIds: posizioni }, ora: ORA, max: 4,
    orizzonteMassimoOre: 150 * 24,
    nettoPerMercato: { [OCC]: nettoOcc, [SFID]: nettoSfid },
    conOrdiniVivi: { leggibile: true, ids: ordini },
  });
}
const spodestato = (d) => (d.spodestati || []).some((x) => x.id === OCC);

console.log('\n══ 1 · IL DIFETTO: con ordini a riposo l\'occupante era intoccabile');
{
  // Positivo contro positivo, con ordini: resta il divieto di sempre.
  const d = decidi({ nettoOcc: 1.0, nettoSfid: 9.0, ordini: [OCC] });
  t('occupante POSITIVO con ordini a riposo: NON si spodesta (③ intatta)', !spodestato(d));
}

console.log('\n══ 2 · LA CURA: occupante in PERDITA, sfidante in GUADAGNO');
{
  const d = decidi({ nettoOcc: -24.92, nettoSfid: 3.70, ordini: [OCC] });
  t('occupante a −$24,92 spodestato da uno sfidante a +$3,70 nonostante gli ordini', spodestato(d));
  const s = (d.spodestati || [])[0] || {};
  t('  e il record dichiara che aveva ordini da cancellare', s.aveviOrdini === true, { aveviOrdini: s.aveviOrdini });
  t('  e nomina i due netti', s.netto === -24.92 && s.nettoNuovo === 3.70, { netto: s.netto, nuovo: s.nettoNuovo });
  t('  e lo sfidante entra', (d.entranti || []).some((x) => x.id === SFID));
  const lib = (d.liberati || []).find((x) => x.id === OCC) || {};
  t('  e il motivo dichiara che gli ordini vanno cancellati esplicitamente',
    /cancellati esplicitamente/.test(lib.dettaglio || ''), (lib.dettaglio || '').slice(-70));
}

console.log('\n══ 3 · IL SEGNO E\' LA SOGLIA, in entrambi i versi');
{
  const a = decidi({ nettoOcc: -24.92, nettoSfid: -1.0, ordini: [OCC] });
  t('perdita contro perdita MINORE: NON si spodesta (si pagherebbe il churn per restare in perdita)', !spodestato(a));
  const b = decidi({ nettoOcc: 0, nettoSfid: 9.0, ordini: [OCC] });
  t('occupante a ZERO (non negativo) con ordini: NON si spodesta', !spodestato(b));
  const c = decidi({ nettoOcc: -24.92, nettoSfid: 0, ordini: [OCC] });
  t('sfidante a ZERO (non positivo): NON si spodesta', !spodestato(c));
}

console.log('\n══ 4 · REGOLA 9 — POSIZIONE e GESTIONE restano intoccabili a qualunque netto');
{
  const a = decidi({ nettoOcc: -99, nettoSfid: 50, ordini: [OCC], posizioni: [OCC] });
  t('occupante con POSIZIONE aperta: NON si spodesta nemmeno a −$99 contro +$50', !spodestato(a));
  const b = decidi({ nettoOcc: -99, nettoSfid: 50, ordini: [OCC], inGestione: true });
  t('occupante IN GESTIONE (coppia incompleta): NON si spodesta', !spodestato(b));
}

console.log('\n══ 5 · L\'ISTERESI NON E\' UNO SCONTO: resta valutata prima del segno');
{
  // margine su −24,92 = max(0,50 · |−24,92|×0,25) = 6,23 ⇒ soglia −18,69.
  // Uno sfidante positivo la supera sempre, quindi si costruisce il caso opposto: occupante
  // leggermente negativo, sfidante positivo ma sotto il margine assoluto di $0,50.
  const d = decidi({ nettoOcc: -0.10, nettoSfid: 0.30, ordini: [OCC] });
  t('sfidante positivo ma dentro il margine di $0,50: NON si spodesta', !spodestato(d),
    { margine: Math.max(0.50, Math.abs(-0.10) * 0.25) });
  const e = decidi({ nettoOcc: -0.10, nettoSfid: 0.90, ordini: [OCC] });
  t('  e appena lo supera, si spodesta', spodestato(e));
}

console.log('\n══ 6 · FAIL-CLOSED: lista ordini non leggibile ⇒ nessuno si spodesta');
{
  const d = S.decidiSelezione({
    board, stato: statoCon(OCC), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 4,
    orizzonteMassimoOre: 150 * 24,
    nettoPerMercato: { [OCC]: -24.92, [SFID]: 3.70 },
    conOrdiniVivi: { leggibile: false, ids: [] },
  });
  t('ordini illeggibili ⇒ nessuno spodestamento', !spodestato(d));
}

console.log('\n══ 7 · IL CABLAGGIO: agent41 cancella PRIMA di rilasciare, e un rifiuto annulla lo scambio');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  const codice = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  t('il flag `aveviOrdini` viene LETTO dal chiamante', /s\.aveviOrdini === true/.test(codice));
  t('  e si cancella davvero (cancelManualOrder sul percorso dello spodestamento)',
    /deps\.cancella \|\| cancelManualOrder\)\(\{ orderId: o\.orderId, marketId: s\.id \}/.test(codice));
  const iCanc = codice.indexOf('spodestamento');
  const iRil = codice.indexOf("rilasciaDallaSelezione({ marketId: s.id, motivo: 'spodestato' })");
  t('  e la cancellazione sta PRIMA del rilascio', iCanc > 0 && iRil > iCanc, { iCanc, iRil });
  t('un rifiuto del venue annulla lo scambio e lo dichiara',
    /spodestamento-annullato/.test(codice) && /scambiFalliti\.set/.test(codice));
  t('  lo sfidante di uno scambio annullato NON entra', /sfidantiAnnullati\.has/.test(codice));
  t('  e l\'occupante torna nello stato salvato', /statoDaSalvare\.selezionati\[idOcc\] = vecchia/.test(codice));
  t('ordini non leggibili sul mercato da spodestare ⇒ scambio annullato (fail-closed)',
    /ordini non leggibili/.test(codice));
}

console.log(`\n${ok} verdi, ${ko} rossi`);
process.exit(ko === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// ⚠ IL RIARMO DI SLOT_STERILE — 20 agosto 2026, e SUPERA UNA DECISIONE REGISTRATA.
// La regola fu DISARMATA il 18 agosto (§4.13) perche' a `OSSERVAZIONI = 2` (~2-4 min) buttava fuori
// mercati che andavano benissimo — cinque volte lo stesso. La misura di stasera dice DI QUANTO: a 4
// minuti si uccidono **10 piazzamenti riusciti su 21 (48%)**. Il riarmo e' legittimo solo perche' la
// soglia cambia, e la differenza e' misurata: a 22 minuti gli uccisi scendono a 3 su 21 (14%).
const M = require('./libro-vuoto-perimetro-pieno');

let ok = 0, ko = 0;
const t = (m, c, x) => { c ? (ok++, console.log('  ✓ ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))) : (ko++, console.log('  ✗ ROSSO: ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))); };

const ORA = 1787000000000;
const MIN = 60_000;
const ordiniOk = (ids = []) => ({ leggibile: true, ids });
const posOk = (ids = []) => ({ leggibile: true, conditionIds: ids });
// ⚠ LA CATENA DI OSSERVAZIONI, e non due letture distanti. `MAX_INTERVALLO_MS` e' 5 minuti: due
// osservazioni piu' lontane NON sono contigue e l'orologio riparte — giustamente, perche' nessuno ha
// visto il libro nel mezzo. La prima stesura di questo test usava due letture a N minuti di distanza e
// falliva su un modulo corretto: il ciclo vero gira ogni 120 s, quindi si simula cosi'.
const catena = (minuti, p = {}, ids = ['0xA']) => {
  let st = M.statoVuoto(); let r = null;
  for (let m = 0; m <= minuti; m += 2) {
    r = M.valuta({ attivi: ids, ordini: ordiniOk(), posizioni: posOk(), stato: st, ora: ORA + m * MIN, ...p });
    st = r.statoNuovo;
  }
  return r;
};
const dopo = (minuti, p = {}) => catena(minuti, p);
// ⚠ IL PRIMO RILASCIO DELLA CATENA, non l'ultimo stato: dopo il rilascio il mercato entra in
// quarantena, quindi ai cicli successivi `azione` torna 'nessuna' — che e' giusto, ma non e' il
// fatto che si sta misurando.
const primoRilascio = (maxMin, p = {}, ids = ['0xA']) => {
  let st = M.statoVuoto();
  for (let m = 0; m <= maxMin; m += 2) {
    const r = M.valuta({ attivi: ids, ordini: ordiniOk(), posizioni: posOk(), stato: st, ora: ORA + m * MIN, ...p });
    st = r.statoNuovo;
    if (r.azione === 'rilascia') return { ...r, minuto: m };
  }
  return null;
};

console.log('\n══ 1 · LA SOGLIA E\' 22 MINUTI, dal vuoto [11,0 · 33,0]');
{
  t('la costante vale 22', M.SOGLIA_MIN === 22, M.SOGLIA_MIN);
  t('a 21 minuti NON si rilascia', dopo(21).azione === 'nessuna');
  t('a 22 minuti si rilascia', dopo(22).azione === 'rilascia');
  const pr = primoRilascio(30);
  t('  e la riga porta i MINUTI, non un conteggio di osservazioni',
    pr !== null && (pr.daRilasciare[0] || {}).minuti === 22, pr && pr.daRilasciare[0]);
  // La vecchia taratura avrebbe rilasciato a 4 minuti: e' il danno che il 18 agosto ha disarmato.
  t('a 4 minuti (la vecchia taratura) NON si rilascia piu\'', dopo(4).azione === 'nessuna');
}

console.log('\n══ 2 · INTOCCABILI (regola 9) — fail-closed, a QUALUNQUE netto');
{
  // ⚠⚠ SI CERCA UN RILASCIO IN TUTTA LA CATENA, non si guarda l'ultimo stato. La prima stesura di
  // questo blocco asseriva `dopo(999).azione === 'nessuna'` ed era VERDE ANCHE TOGLIENDO LA GUARDIA:
  // dopo un rilascio il mercato entra in quarantena, quindi l'ultimo stato dice 'nessuna' comunque.
  // Verificato togliendo `conPosizione.has(id) continue` dal modulo: 35/0, cioe' la guardia piu'
  // importante non era protetta da niente. E' la classe «asserzione verde su una proprieta' falsa»,
  // la stessa incontrata tre volte oggi.
  const lungo = 400;   // ben oltre soglia e quarantena: se puo' rilasciare, in 400 min lo fa
  t('con una POSIZIONE aperta non si rilascia MAI in tutta la catena',
    primoRilascio(lungo, { posizioni: posOk(['0xA']) }) === null);
  t('con anche UN SOLO ordine vivo non si rilascia MAI in tutta la catena',
    primoRilascio(lungo, { ordini: ordiniOk(['0xA']) }) === null);
  // L'occupante a −$99 contro uno sfidante a +$50: il modulo NON guarda il netto, ed e' il punto.
  t('  un intoccabile a −$99 contro uno sfidante a +$50 resta dov\'e\'',
    primoRilascio(lungo, { posizioni: posOk(['0xA']) }) === null);
  t('  e il CONTROLLO: senza la posizione, lo stesso mercato viene rilasciato',
    primoRilascio(lungo) !== null);
  t('  e la funzione non accetta affatto un netto: la tentazione non e\' esprimibile',
    !/netto/.test(M.valuta.toString().slice(0, 400)));
  t('posizioni NON leggibili ⇒ nessun rilascio (fail-closed)',
    primoRilascio(lungo, { posizioni: { leggibile: false } }) === null);
  t('  e lo dichiara nominando la regola 9',
    /regola 9/.test(dopo(lungo, { posizioni: { leggibile: false } }).motivo));
  t('ordini NON leggibili ⇒ nessun rilascio (fail-closed)',
    primoRilascio(lungo, { ordini: { leggibile: false } }) === null);
  t('orologio non leggibile ⇒ nessun rilascio',
    M.valuta({ attivi: ['0xA'], ordini: ordiniOk(), posizioni: posOk(), stato: M.statoVuoto(), ora: NaN }).azione === 'nessuna');
}

console.log('\n══ 3 · LA QUARANTENA — 180 minuti, e non si rilascia due volte');
{
  t('la costante vale 180', M.QUARANTENA_MIN === 180, M.QUARANTENA_MIN);
  const primo = primoRilascio(30);
  t('primo rilascio avviene', primo !== null && primo.azione === 'rilascia', primo && { minuto: primo.minuto });
  t('  e il mercato entra in quarantena', (primo.inQuarantena || []).includes('0xa'));
  // Resta a zero e la catena continua: dentro i 180 minuti NON si rilascia una seconda volta.
  let st = primo.statoNuovo, r = null;
  for (let m = 32; m <= 100; m += 2) {
    r = M.valuta({ attivi: ['0xA'], ordini: ordiniOk(), posizioni: posOk(), stato: st, ora: ORA + m * MIN });
    st = r.statoNuovo;
  }
  t('dentro la quarantena non si rilascia di nuovo', r.azione === 'nessuna');
  t('  e il motivo nomina la quarantena', /quarantena/.test(r.motivo), r.motivo.slice(0, 80));
  // ⚠ SI CERCA L'ISTANTE DEL SECONDO RILASCIO, non si guarda uno stato a caso. La prima stesura
  // asseriva su m=260, che cade DENTRO la seconda quarantena — e falliva su un modulo corretto.
  let secondo = null;
  for (let m = 102; m <= 400; m += 2) {
    r = M.valuta({ attivi: ['0xA'], ordini: ordiniOk(), posizioni: posOk(), stato: st, ora: ORA + m * MIN });
    st = r.statoNuovo;
    if (r.azione === 'rilascia' && secondo === null) secondo = m;
  }
  t('oltre i 180 minuti la quarantena scade e si rilascia di nuovo', secondo !== null, { minuto: secondo });
  t('  e succede a ~180 minuti dal primo rilascio, non prima',
    secondo !== null && secondo - 22 >= M.QUARANTENA_MIN, { primo: 22, secondo, distanza: secondo - 22 });
}

console.log('\n══ 4 · IL TETTO ORARIO — 5, uno sopra il picco misurato di 4');
{
  t('la costante vale 5', M.TETTO_RILASCI_ORA === 5, M.TETTO_RILASCI_ORA);
  // ⚠ SI GUARDA IL CICLO IN CUI IL TETTO MORDE — il primo che supera la soglia — non l'ultimo della
  // catena: ai cicli dopo i cinque rilasciati sono in quarantena e i due residui restano fermi per il
  // tetto, quindi `daRilasciare` e' 0 e l'asserzione misurerebbe un altro fatto.
  const ids = ['0xA', '0xB', '0xC', '0xD', '0xE', '0xF', '0xG'];
  let st2 = M.statoVuoto(); let b = null; let primoTaglio = null;
  for (let m = 0; m <= 30; m += 2) {
    b = M.valuta({ attivi: ids, ordini: ordiniOk(), posizioni: posOk(), stato: st2, ora: ORA + m * MIN });
    st2 = b.statoNuovo;
    if (b.azione === 'rilascia' && primoTaglio === null) primoTaglio = b;
  }
  t('sette slot sterili insieme ⇒ se ne rilasciano al massimo 5',
    primoTaglio && primoTaglio.daRilasciare.length === 5, primoTaglio && primoTaglio.daRilasciare.length);
  t('  e il tetto e\' DICHIARATO, non silenzioso', primoTaglio && primoTaglio.tettoRaggiunto === true);
  t('  con l\'elenco di chi resta occupato',
    primoTaglio && (primoTaglio.troncati || []).length === 2, primoTaglio && (primoTaglio.troncati || []).map((x) => x.id));
  t('  e il motivo lo dice', primoTaglio && /tetto di 5/.test(primoTaglio.motivo), primoTaglio && primoTaglio.motivo.slice(0, 90));
}

console.log('\n══ 5 · LE DUE CAUSE OPPOSTE DEL LIBRO VUOTO restano distinte');
{
  const a = catena(10);
  const b = M.valuta({ attivi: ['0xA'], ordini: ordiniOk(), posizioni: posOk(), stato: a.statoNuovo,
    ora: ORA + 12 * MIN, svuotatiDaNoi: ['0xA'] });
  t('«svuotato da NOI» non conta come sterile', b.azione === 'nessuna');
  t('  e l\'orologio si CONSERVA, non riparte da zero', (b.nonContate[0] || {}).daConservato === ORA,
    { daConservato: (b.nonContate[0] || {}).daConservato, atteso: ORA });
  const c = M.valuta({ attivi: ['0xA'], ordini: ordiniOk(), posizioni: posOk(), stato: a.statoNuovo,
    ora: ORA + 12 * MIN, piazzatiConSuccesso: ['0xA'] });
  t('un piazzamento riuscito AZZERA: quel mercato non e\' sterile', c.azione === 'nessuna' && !c.zeroDa['0xa']);
}

console.log('\n══ 6 · IL CABLAGGIO — agent41 passa posizioni e usa la quarantena');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  const cod = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  t('le POSIZIONI vengono passate a LVPP.valuta (senza, la regola 9 blocca tutto)',
    /LVPP\.valuta\(\{[^)]*posizioni,/.test(cod));
  t('la quarantena dello slot sterile entra nell\'`escludi` della selezione',
    /statoLibroVuoto && statoLibroVuoto\.quarantena/.test(cod) && /LVPP\.QUARANTENA_MS/.test(cod));
  t('  e si UNISCE alla quarantena del venue, non la sostituisce',
    /new Set\(\[\.\.\.base, \.\.\.sterili\]\)/.test(cod));
  t('la riga di giornale distingue il rilascio UTILE da quello inutile',
    /rientroDelloStesso/.test(cod) && /utile: !!subentrato && !rientroStesso/.test(cod));
  t('  e registra minuti a zero, netto, subentrato e suo netto',
    /minutiAZeroOrdini: x\.minuti/.test(cod) && /nettoSubentrato/.test(cod));
  const eco = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'ecosystem.config.js'), 'utf8');
  t('`SLOT_STERILE_ARMATO` NON e\' piu\' nell\'ecosystem ⇒ la regola e\' ARMATA',
    !/SLOT_STERILE_ARMATO/.test(eco));
  t('  e il codice arma in assenza della variabile, non in presenza',
    /SLOT_STERILE_ARMATO \?\? ''\)\.trim\(\) !== '0'/.test(cod));
}

console.log(`\n${ok} verdi, ${ko} rossi`);
process.exit(ko === 0 ? 0 : 1);

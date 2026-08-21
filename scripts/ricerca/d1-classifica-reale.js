'use strict';
// SOLA LETTURA — la classifica con la FUNZIONE VERA `ordinaCandidati`, nei due mondi e nei due regimi.
const fs = require('fs'); const path = require('path');
const R = path.resolve(__dirname, '..', '..');
const SEL = require(path.join(R, 'lib', 'maker', 'selezione-mercati'));
const SIM = JSON.parse(fs.readFileSync(path.join(R, 'data', 'ricerca', 'd1-simulazione-a-secco.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(R, 'data', 'liquidity-rewards.json'), 'utf8'));
const MER = Array.isArray(BOARD) ? BOARD : BOARD.markets;
const perId = new Map(MER.map((m) => [String(m.conditionId).toLowerCase(), m]));
const amm = SIM.righe.filter((r) => r.ammissibile);

/** Una riga di board con i `levels` sostituiti da un solo livello che porta il punteggio voluto. */
const conPunteggio = (r, valore) => ({ ...perId.get(r.id), levels: { 500: { grossRewardDay: valore } } });
const righeVecchie = amm.map((r) => conPunteggio(r, r.pVecchio));
const righeNuove   = amm.map((r) => conPunteggio(r, r.pNuovo));
const nome = (m) => String(m.question || '').slice(0, 40);
const nettiTutti = Object.fromEntries(amm.map((r, i) => [r.id, 10 - i * 0.1]));   // un netto per OGNI candidato

function mostra(tit, a, b) {
  console.log(`\n── ${tit} ──`);
  const ua = a.map(nome), ub = b.map(nome);
  for (let i = 0; i < ua.length; i++) console.log(`  ${String(i + 1).padStart(2)}  ${ua[i].padEnd(42)} | ${ub[i]}`);
  console.log(`  ORDINE IDENTICO: ${JSON.stringify(ua) === JSON.stringify(ub) ? 'SI' : 'NO'}`);
  return JSON.stringify(ua) === JSON.stringify(ub);
}
console.log('candidati ammissibili:', amm.length, '· slot:', process.env.MAKER_MERCATI_CONTEMPORANEI || 5);
console.log('       (colonna sinistra = punteggio di PRODUZIONE · destra = punteggio CORRETTO)');
const r1 = mostra('REGIME REALE — un netto-knapsack per OGNI candidato (nettiIniettati = ammissibili)',
  SEL.ordinaCandidati(righeVecchie, nettiTutti), SEL.ordinaCandidati(righeNuove, nettiTutti));
const r2 = mostra('REGIME DEGRADATO — nessun netto disponibile: decide il ripiego LORDO',
  SEL.ordinaCandidati(righeVecchie, null), SEL.ordinaCandidati(righeNuove, null));
console.log(`\n⇒ col netto la correzione NON tocca la classifica: ${r1 ? 'CONFERMATO' : 'SMENTITO'}`);
console.log(`⇒ senza netto la correzione cambia la classifica: ${r2 ? 'NO' : 'SI'}`);

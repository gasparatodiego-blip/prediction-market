#!/usr/bin/env node
'use strict';
// DUE FONTI SUL MONTEPREMI NON POSSONO DIRE IL CONTRARIO SENZA CHE NESSUNO SE NE ACCORGA.
//
// ═══ IL PROBLEMA 1 ═══════════════════════════════════════════════════════════════════════════════════
// 4 agosto 2026, tab «Ottimizza». Una card di proposta mostrava «✓ montepremi $57/g» e un netto di
// $4.81/g su «Will the Democratic Party win the TX-15 House seat?». Aprendo «1 · Anteprima» sulla stessa
// card, a pochi secondi di distanza:
//
//     NESSUN REWARD — solo trading direzionale: questo mercato non ha montepremi di liquidità,
//     quindi qualunque ordine qui non produce reward.
//
// Due affermazioni opposte sullo stesso mercato. Chi si fida della card senza aprire l'anteprima
// alloca capitale reale su pura esposizione direzionale.
//
// ═══ PERCHÉ PUÒ SUCCEDERE, INDIPENDENTEMENTE DA COSA L'HA CAUSATO QUELLA VOLTA ═══════════════════════
// Le due cifre vengono da due letture diverse dello stesso fatto:
//
//     card       →  data/liquidity-rewards.json      il board, che agent24 riscrive ogni ~15 minuti
//     anteprima  →  Gamma /markets?condition_ids=…   il venue, adesso
//
// Due fonti indipendenti, e finora NIENTE che le confrontasse. Che quella sera avesse ragione l'una o
// l'altra non cambia cosa fare: se non concordano sul fatto che un mercato paghi, non si abilita.
// Questo file prova che la contraddizione ora è un fermo duro e non un'incongruenza silenziosa.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// La regola del gate, isolata come la applica la route. Se la route cambiasse forma, le asserzioni sui
// sorgenti più sotto se ne accorgono.
const contraddice = (potAtPlan, hasRewards) => potAtPlan != null && potAtPlan > 0 && hasRewards !== true;

console.log('\n══ 1 · LA REGOLA: pot dalla card + nessun reward dal venue ⇒ FERMO');
{
  ok('card $57/g e venue senza reward → contraddizione', contraddice(57, false) === true);
  ok('  anche se hasRewards è undefined (non letto ≠ letto true)', contraddice(57, undefined) === true);
  ok('  e se è null', contraddice(57, null) === true);
  ok('card $57/g e venue con reward → nessuna contraddizione', contraddice(57, true) === false);
  ok('card senza pot e venue senza reward → coerenti, si abilita', contraddice(0, false) === false);
  ok('  un mercato senza reward resta abilitabile di proposito', contraddice(null, false) === false);
  ok('card senza pot ma venue CON reward → non è un fermo', contraddice(null, true) === false,
    'il venue paga più di quanto il piano sapesse: non è una ragione per fermare niente');
}

console.log('\n══ 2 · IL FERMO È NELLA ROUTE, E NON SCRIVE NIENTE');
{
  const r = leggi('app', 'api', 'maker', 'markets', 'enable', 'route.ts');
  ok('la route accetta il montepremi dichiarato dalla card', /potAtPlan: z\.number\(\)/.test(r));
  ok('  e lo confronta con quello del venue',
    /const contraddizionePot = potAtPlan != null && potAtPlan > 0 && m\.hasRewards !== true/.test(r));
  ok('esiste il gate reward-contraddizione', /gate: 'reward-contraddizione'/.test(r));
  ok('  che RITORNA prima di qualunque scrittura', (() => {
    const iGate = r.indexOf("gate: 'reward-contraddizione'");
    const iScrittura = r.indexOf('const cat = upsertMarket(');
    return iGate > 0 && iScrittura > 0 && iGate < iScrittura;
  })(), 'un fermo dopo la scrittura non è un fermo');
  ok('  e riporta ENTRAMBE le cifre, non solo la propria',
    /potAtPlan, potAlVenue: m\.rewardsDailyRate/.test(r));
  ok('  dicendo che non si sa quale sia giusta, invece di sceglierne una',
    /Ricalcola il piano/.test(r));
  ok('la deriva NON contraddittoria è solo un avviso, non un fermo',
    /Il montepremi è cambiato da quando il piano è stato calcolato/.test(r),
    'un pot che cambia da 57 a 61 non è la stessa cosa di un pot che sparisce');
}

console.log('\n══ 3 · IL PANNELLO DICHIARA LA CIFRA SU CUI SI È DECISO');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('addMarket accetta il pot della card', /addMarket = useCallback\(async \(marketId: string, preview: boolean, potAtPlan\?/.test(p));
  ok('  e lo manda al server', /potAtPlan: typeof potAtPlan === 'number'/.test(p));
  ok('l anteprima lo passa dalla card', /addMarket\(c\.marketId, true, c\.pot\)/.test(p));
  ok('  E ANCHE LA CONFERMA — è il passo che scrive',
    /addMarket\(addPreview\.marketId, false, addPreview\.summary\?\.rewardsDailyRate/.test(p),
    'controllare solo l anteprima lascerebbe scoperto proprio il momento in cui si abilita');
}

console.log('\n══ 4 · PROBLEMA 2 — LA CODA LEGGE LE RIGHE DEL PIANO GIUSTO');
{
  // In questo pannello i piani sono DUE, con due bottoni e due stati:
  //   `plan`     ← «Calcola»
  //   `autoPlan` ← «Cerca la combinazione migliore»  → è questo che rende le card di proposta
  // La mappa che alimenta la coda leggeva solo `plan.rows`: chi arrivava alle proposte dal percorso
  // normale aveva `plan` a null, la mappa restava vuota e il bottone «+ Metti in coda» non veniva
  // renderizzato MAI. Non era nascosto da un flag: non esisteva a schermo.
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('righePerId legge le righe di ENTRAMBI i piani',
    /for \(const r of plan\?\.rows \?\? \[\]\)[\s\S]{0,120}for \(const r of autoPlan\?\.rows \?\? \[\]\)/.test(p));
  ok('  con autoPlan che vince: è la riga della card che si sta guardando', (() => {
    const i = p.indexOf('const righePerId = useMemo');
    const blocco = p.slice(i, i + 600);
    return blocco.indexOf('plan?.rows') < blocco.indexOf('autoPlan?.rows');
  })());
  ok('  e la dipendenza include autoPlan', /\}, \[plan, autoPlan\]\);/.test(p));
  ok('il bottone «+ Metti in coda» esiste ed è condizionato alla riga', /data-alloc-queue-add/.test(p)
    && /righePerId\.has\(c\.marketId\.toLowerCase\(\)\) && \(/.test(p));
  ok('la coda usa ancora targetFromPlanRow, non un ricalcolo', /targetFromPlanRow\(testaRiga,/.test(p));
}

console.log('\n══ 5 · IL CONTROLLO DAL VIVO: nessun mercato proposto è contraddittorio (punto 5)');
(async () => {
  let board = null;
  try { board = JSON.parse(leggi('data', 'liquidity-rewards.json')); } catch { /* assente */ }
  if (!board || !Array.isArray(board.markets)) {
    console.log('      board assente — il controllo dal vivo si salta, non si finge superato');
  } else {
    // I mercati che il board dichiara paganti: sono quelli da cui l'allocatore può pescare, e quindi
    // gli unici che possono finire su una card con un montepremi scritto sopra.
    const conPot = board.markets.filter((m) => Number(m.rewardsDailyRate) > 0);
    const campione = conPot.slice(0, 12);           // dodici, per non martellare il venue in un test
    let controllati = 0, contraddittori = 0, nonRaggiungibili = 0;
    const casi = [];
    try {
      const { fetchMarketByConditionId } = require('../maker/market-search');
      for (const m of campione) {
        const r = await fetchMarketByConditionId(m.conditionId);
        if (!r.ok || !r.market) { nonRaggiungibili += 1; continue; }
        controllati += 1;
        if (contraddice(Number(m.rewardsDailyRate), r.market.hasRewards)) {
          contraddittori += 1;
          casi.push(`${(m.question || m.conditionId).slice(0, 44)} — board $${m.rewardsDailyRate}/g, venue NESSUN REWARD`);
        }
        await new Promise((x) => setTimeout(x, 120));
      }
    } catch (e) {
      console.log('      venue non interrogabile (' + e.message.slice(0, 40) + ') — controllo saltato, non superato');
    }
    if (controllati > 0) {
      ok(`nessuna contraddizione board↔venue su ${controllati} mercati paganti`,
        contraddittori === 0, contraddittori ? casi.join(' · ') : `${nonRaggiungibili} non raggiungibili`);
    } else {
      console.log('      nessun mercato raggiunto: il controllo dal vivo non ha potuto girare');
    }
  }
  console.log(`\nmontepremi coerente: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

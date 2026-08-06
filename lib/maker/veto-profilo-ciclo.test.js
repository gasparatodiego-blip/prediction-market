#!/usr/bin/env node
'use strict';
// IL VETO DI PROFILO DENTRO IL CICLO VERO — non la funzione da sola, il ciclo che la chiama.
//
// ═══ COSA DIMOSTRA ═══════════════════════════════════════════════════════════════════════════════════
//   1. `runAutoRepriceCycle` legge il profilo del mercato e lo passa a `valutaPiazzamento`;
//   2. un verdetto negativo trasforma l'azione in `skip` con un gate suo — quindi nessun ordine parte;
//   3. il veto è SOLO restrittivo: non trasforma mai uno `skip` in un `reprice`, e non tocca `hold`;
//   4. il profilo viene riletto A OGNI GIRO, quindi un mercato che cambia profilo cambia percorso;
//   5. senza le due dipendenze iniettate il ciclo è quello di prima — è ciò che tiene verdi i test
//      che esercitano `decideReprice` da solo.
//
// NESSUN ORDINE REALE: `replaceOrder` e `cancelOrder` sono funzioni di questo file, e contano le
// chiamate invece di farne.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAutoRepriceCycle } = require('./auto-reprice');
const cfgMod = require('./auto-reprice-config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + 'ab'.repeat(32);

/**
 * Un banco in cui `decideReprice` vorrebbe RIPREZZARE: il nostro ordine è il migliore del lato e un
 * tick dietro resta in banda. Senza veto l'azione è `reprice`; col veto diventa `skip`.
 */
function banco({ profilo = 'safe', verdetto = { ok: true }, conVeto = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veto-profilo-'));
  const configDeps = {
    configFile: path.join(dir, 'auto-reprice.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  cfgMod.setAutoReprice({ scope: 'global', enabled: true, by: 'test', reason: 'banco' }, configDeps);
  cfgMod.setAutoReprice({ scope: 'market', marketId: MKT, enabled: true, by: 'test', reason: 'banco' }, configDeps);

  const visti = [];
  const rimpiazzi = [];
  const deps = {
    now: () => 9_000_000,
    configDeps,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false, minutesToClose: 600, minMinutes: 3 }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid: 0.78, tick: 0.01, minSize: 20,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: 0.78 }, no: { tokenId: 'tn', scoringMid: 0.22 } },
    }),
    // Il nostro ordine a 79¢ è il migliore del lato: `decideReprice` vuole spostarlo a 77¢.
    listOrders: async () => ({ ok: true, simulated: false, orders: [
      { orderId: 'o1', marketId: MKT, tokenId: 'ty', side: 'BUY', price: 0.79, size: 20.2,
        sizeRemaining: 20.2, status: 'LIVE', source: 'manual-ui' },
    ] }),
    resolveDepth: () => ({
      yes: { bids: [{ price: 0.79, size: 20.2 }, { price: 0.78, size: 60 }], asks: [{ price: 0.85, size: 99 }] },
      no: { bids: [], asks: [] },
    }),
    cancelOrder: async () => ({ ok: true }),
    replaceOrder: async (spec) => { rimpiazzi.push(spec); return { ok: true, orderId: 'o2' }; },
    audit: () => {},
  };
  if (conVeto) {
    deps.leggiProfilo = (marketId) => { visti.push(marketId); return { profile: profilo, readable: true, stale: false, ageSec: 10, reason: `profilo ${profilo}` }; };
    deps.valutaPiazzamento = (arg) => { visti.push(`valuta:${arg.profilo}`); return verdetto; };
  }
  return { deps, visti, rimpiazzi, pulisci: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Le azioni stanno in `res.actions` (livello alto), non dentro `res.markets[]` — quello porta i
// CONTATORI del mercato (considered/held/skipped/repriced), non le singole azioni. Cercarle nel posto
// sbagliato restituiva undefined e ogni assert falliva senza dire perché.
const azioneDi = (res) => (res.actions || []).find((a) => String(a.marketId).toLowerCase() === MKT.toLowerCase()) || null;

(async () => {
  console.log('\n══ 1 · SENZA VETO IL CICLO RIPREZZA (il banco non è vuoto)');
  {
    const b = banco({ conVeto: false });
    const res = await runAutoRepriceCycle(b.deps);
    const a = azioneDi(res);
    ok('l azione è reprice', a && a.action === 'reprice', a ? `${a.action}/${a.gate}` : 'nessuna azione');
    ok('  ed è stato chiesto un rimpiazzo al venue', b.rimpiazzi.length === 1, `${b.rimpiazzi.length}`);
    b.pulisci();
  }

  console.log('\n══ 2 · IL VETO TRASFORMA IL RIPREZZO IN SKIP — NESSUN ORDINE PARTE');
  {
    const b = banco({ profilo: 'risk', verdetto: { ok: false, reason: 'gradino sotto il pavimento di $20' } });
    const res = await runAutoRepriceCycle(b.deps);
    const a = azioneDi(res);
    ok('l azione diventa skip', a && a.action === 'skip', a ? `${a.action}/${a.gate}` : 'nessuna azione');
    ok('  col gate del profilo', a && a.gate === 'profilo-non-conforme', a && a.gate);
    ok('  e il motivo nomina il profilo e la causa',
      a && /profilo risk/.test(a.reason) && /pavimento di \$20/.test(a.reason), a && a.reason);
    ok('NESSUN rimpiazzo è stato chiesto al venue', b.rimpiazzi.length === 0, `${b.rimpiazzi.length}`);
    b.pulisci();
  }

  console.log('\n══ 3 · IL PROFILO LETTO È QUELLO PASSATO ALLA VALUTAZIONE');
  {
    for (const p of ['safe', 'risk']) {
      const b = banco({ profilo: p, verdetto: { ok: true } });
      await runAutoRepriceCycle(b.deps);
      ok(`profilo ${p}: letto dallo store e inoltrato`, b.visti.includes(`valuta:${p}`), b.visti.join(' · '));
      ok(`  e il marketId chiesto è quello giusto`, b.visti[0] === MKT);
      b.pulisci();
    }
  }

  console.log('\n══ 4 · PROFILO SCONOSCIUTO ⇒ SI SALTA, NON SI RICADE SU SAFE');
  {
    const b = banco();
    // Lo store non sa dire il profilo (mercato fuori piano, o piano scaduto).
    b.deps.leggiProfilo = () => ({ profile: null, readable: true, stale: false, ageSec: 30,
      reason: 'questo mercato non compare nel piano corrente' });
    // La valutazione VERA rifiuta un profilo null: qui si usa quella vera, non una spia compiacente.
    b.deps.valutaPiazzamento = require('./regole-piazzamento').valutaPiazzamento;
    const res = await runAutoRepriceCycle(b.deps);
    const a = azioneDi(res);
    ok('azione skip', a && a.action === 'skip' && a.gate === 'profilo-non-conforme', a ? `${a.action}/${a.gate}` : '—');
    ok('  e il motivo riporta perché il profilo manca',
      a && /non compare nel piano/.test(a.reason), a && a.reason);
    ok('nessun ordine inviato', b.rimpiazzi.length === 0);
    b.pulisci();
  }

  console.log('\n══ 5 · UN ERRORE NELLA VALUTAZIONE NON APRE: SI SALTA');
  {
    const b = banco();
    b.deps.valutaPiazzamento = () => { throw new Error('boom'); };
    const res = await runAutoRepriceCycle(b.deps);
    const a = azioneDi(res);
    ok('azione skip', a && a.action === 'skip' && a.gate === 'profilo-non-conforme', a ? a.gate : '—');
    ok('  col motivo dell errore', a && /boom/.test(a.reason), a && a.reason);
    ok('  nessun ordine inviato', b.rimpiazzi.length === 0,
      'una regola che non ha potuto girare non è una regola superata');
    b.pulisci();
  }

  console.log('\n══ 6 · IL VETO È SOLO RESTRITTIVO');
  {
    // Un verdetto POSITIVO non deve creare azioni: se `decideReprice` diceva reprice, resta reprice.
    const b = banco({ verdetto: { ok: true } });
    const res = await runAutoRepriceCycle(b.deps);
    const a = azioneDi(res);
    ok('verdetto positivo ⇒ l azione resta quella di decideReprice', a && a.action === 'reprice', a && a.action);
    ok('  e il rimpiazzo avviene', b.rimpiazzi.length === 1);
    b.pulisci();

    // Su un libro sano `decideReprice` dice `hold`: il veto non deve nemmeno essere consultato,
    // perché non c'è niente da impedire.
    const c = banco({ verdetto: { ok: false, reason: 'no' } });
    c.deps.resolveDepth = () => ({
      yes: { bids: [{ price: 0.80, size: 60 }, { price: 0.79, size: 20.2 }], asks: [{ price: 0.85, size: 99 }] },
      no: { bids: [], asks: [] },
    });
    const res2 = await runAutoRepriceCycle(c.deps);
    const a2 = azioneDi(res2);
    ok('su hold il veto non viene nemmeno consultato',
      (a2 == null || a2.action === 'hold') && !c.visti.some((v) => String(v).startsWith('valuta:')),
      `${a2 ? a2.action : 'nessuna azione'} · visti: ${c.visti.join(',') || 'nessuno'}`);
    c.pulisci();
  }

  console.log('\n══ 7 · IL PROFILO SI RILEGGE A OGNI GIRO');
  {
    // Stesso banco, due cicli, profilo cambiato in mezzo: il secondo giro deve vedere il nuovo.
    const b = banco();
    let prof = 'safe';
    const inoltrati = [];
    b.deps.leggiProfilo = () => ({ profile: prof, readable: true, stale: false, ageSec: 1, reason: 'x' });
    b.deps.valutaPiazzamento = (arg) => { inoltrati.push(arg.profilo); return { ok: true }; };

    await runAutoRepriceCycle(b.deps);
    prof = 'risk';
    await runAutoRepriceCycle(b.deps);
    prof = 'safe';
    await runAutoRepriceCycle(b.deps);

    ok('tre cicli, tre letture, il profilo del momento',
      JSON.stringify(inoltrati) === JSON.stringify(['safe', 'risk', 'safe']), inoltrati.join(' → '));
    ok('  nessun profilo appiccicato dal giro precedente', inoltrati[2] === 'safe');
    b.pulisci();
  }

  console.log(`\nveto di profilo nel ciclo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FALLITO:', e && e.stack ? e.stack : String(e)); process.exit(1); });

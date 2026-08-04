#!/usr/bin/env node
'use strict';
// NON ESISTE UN MERCATO GESTITO DAL BOT SENZA VIA D'USCITA.
//
// Fino al 4 agosto 2026 `setAutoClose` non veniva chiamato da nessuna parte nel percorso che piazza:
// l'interruttore globale era acceso, ma l'opt-in per mercato no. Tre mercati vecchi ce l'avevano,
// NESSUNO dei mercati che il piano sceglieva. Un fill su uno di quelli lasciava le share senza nessuna
// via d'uscita e il capitale fermo fino alla risoluzione.
//
// Le tre regole che questo file blinda:
//   1. si ACCENDE nella fase 3, cioè PRIMA che la fase 4 crei un solo ordine — mai una finestra in cui
//      le gambe sono vive e l'uscita è spenta;
//   2. si SPEGNE con le gambe quando il mercato esce dal piano e non ha posizioni;
//   3. NON si spegne se una posizione è ancora aperta — né se non si riesce a leggere se lo è.

const { runAllocationReset } = require('./allocation-reset');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const A = '0x' + 'a1'.repeat(32);   // era abilitato, esce dal piano
const B = '0x' + 'b2'.repeat(32);   // era abilitato, resta nel piano
const C = '0x' + 'c3'.repeat(32);   // nuovo, entra nel piano

const coppia = (marketId) => ([
  { marketId, book: 'yes', side: 'BUY', price: 0.49, size: 100, coppia: marketId, gamba: 'yes' },
  { marketId, book: 'no', side: 'BUY', price: 0.49, size: 100, coppia: marketId, gamba: 'no' },
]);

/** Il mondo finto: ogni effetto è registrato, in ORDINE, così si può provare la sequenza e non solo l'esito. */
function mondo(opts = {}) {
  const eventi = [];   // la cronologia completa, per verificare che l'uscita preceda il piazzamento
  const deps = {
    now: () => 1_700_000_000_000,
    readEnabled: () => (opts.abilitati || [A, B]),
    readTracking: () => [],
    listOrders: async () => ({ ok: true, orders: [] }),
    cancelOrder: async () => ({ ok: true }),
    setTrackingOff: async () => ({ ok: true }),
    setEnabled: async ({ marketId, enabled }) => { eventi.push({ e: enabled ? 'abilita' : 'disabilita', marketId }); return { ok: true }; },
    setManual: async ({ marketId }) => { eventi.push({ e: 'manuale', marketId }); return { ok: true }; },
    setAutoClose: async ({ marketId, enabled }) => {
      eventi.push({ e: enabled ? 'uscita-ON' : 'uscita-OFF', marketId });
      return opts.autoCloseFallisce === marketId ? { ok: false, error: 'registro non scrivibile' } : { ok: true };
    },
    posizioneAperta: opts.posizioneAperta,
    placeBulk: async ({ rows }) => { eventi.push({ e: 'PIAZZA', righe: rows.length }); return { ok: true, placed: rows.length, refused: 0, skipped: 0, results: [], totals: {} }; },
    audit: () => {},
  };
  return { deps, eventi };
}

(async () => {

  console.log('\n══ 1 · L USCITA SI ACCENDE PRIMA CHE GLI ORDINI ESISTANO');
  {
    const m = mondo({ posizioneAperta: async () => ({ leggibile: true, aperta: false }) });
    const r = await runAllocationReset({ rows: [...coppia(B), ...coppia(C)] }, m.deps);
    ok('il reset e riuscito', r.ok === true, r.reason || '');

    const iPiazza = m.eventi.findIndex((x) => x.e === 'PIAZZA');
    const accensioni = m.eventi.map((x, i) => ({ ...x, i })).filter((x) => x.e === 'uscita-ON');
    ok('l uscita e stata accesa su ENTRAMBI i mercati del piano',
      accensioni.length === 2 && accensioni.some((x) => x.marketId === B) && accensioni.some((x) => x.marketId === C),
      JSON.stringify(accensioni.map((x) => x.marketId.slice(0, 6))));
    ok('  e OGNI accensione precede il piazzamento',
      accensioni.every((x) => x.i < iPiazza),
      `piazzamento all indice ${iPiazza}, accensioni a ${accensioni.map((x) => x.i).join(',')}`);
    ok('  quindi non esiste un istante con gambe vive e uscita spenta', iPiazza === m.eventi.length - 1);
    ok('il referto dichiara l uscita per ogni mercato acceso',
      r.accensione.markets.every((x) => x.uscitaAutomatica === true), JSON.stringify(r.accensione.markets.map((x) => x.uscitaAutomatica)));
  }

  console.log('\n══ 2 · SE L USCITA NON SI ACCENDE, QUEL PIANO NON SI PIAZZA');
  {
    const m = mondo({ posizioneAperta: async () => ({ leggibile: true, aperta: false }), autoCloseFallisce: C });
    const r = await runAllocationReset({ rows: [...coppia(B), ...coppia(C)] }, m.deps);
    ok('il reset si ferma', r.ok === false && r.stoppedBy === 'enable-failed', `${r.stoppedBy}`);
    ok('  e NESSUN ordine viene piazzato', !m.eventi.some((x) => x.e === 'PIAZZA'));
    ok('  il motivo nomina l uscita automatica', /uscita automatica/.test(r.reason), r.reason.slice(0, 120));
    ok('  e dice perche: meglio un mercato in meno', /nessuna via d'uscita/.test(r.reason));
  }

  console.log('\n══ 3 · CHI ESCE DAL PIANO SENZA POSIZIONI PERDE ANCHE L USCITA');
  {
    const m = mondo({ posizioneAperta: async () => ({ leggibile: true, aperta: false }) });
    const r = await runAllocationReset({ rows: coppia(B) }, m.deps);
    ok('A esce dal piano ed e stato disabilitato', m.eventi.some((x) => x.e === 'disabilita' && x.marketId === A));
    ok('  e la sua uscita e stata SPENTA', m.eventi.some((x) => x.e === 'uscita-OFF' && x.marketId === A));
    ok('  B resta nel piano e la sua uscita resta ACCESA',
      m.eventi.some((x) => x.e === 'uscita-ON' && x.marketId === B)
      && !m.eventi.some((x) => x.e === 'uscita-OFF' && x.marketId === B));
    ok('  e nessun mercato figura fra quelli tenuti accesi', r.spegnimento.uscitaTenutaAccesa.length === 0);
  }

  console.log('\n══ 4 · CHI ESCE DAL PIANO CON UNA POSIZIONE APERTA TIENE L USCITA ACCESA');
  {
    // È il caso che conta: una gamba era stata ESEGUITA. Quelle share sono ancora nostre, e l'uscita
    // automatica è l'unica cosa che possa liberarle. Spegnerla qui vorrebbe dire abbandonarle.
    const m = mondo({ posizioneAperta: async ({ marketId }) => ({ leggibile: true, aperta: marketId === A }) });
    const r = await runAllocationReset({ rows: coppia(B) }, m.deps);
    ok('A esce dal piano...', m.eventi.some((x) => x.e === 'disabilita' && x.marketId === A));
    ok('  ma la sua uscita NON viene spenta', !m.eventi.some((x) => x.e === 'uscita-OFF' && x.marketId === A));
    ok('  ed e dichiarato nel referto', r.spegnimento.uscitaTenutaAccesa.length === 1
      && r.spegnimento.uscitaTenutaAccesa[0].marketId === A, JSON.stringify(r.spegnimento.uscitaTenutaAccesa));
    ok('  col motivo vero: ha una posizione da chiudere',
      /posizione aperta da chiudere/.test(r.spegnimento.uscitaTenutaAccesa[0].perche),
      r.spegnimento.uscitaTenutaAccesa[0].perche);
  }

  console.log('\n══ 5 · SE NON SI RIESCE A LEGGERE LE POSIZIONI, L USCITA RESTA ACCESA');
  {
    // Fail-closed VERSO L'ACCESO, e con intenzione: accesa su un mercato vuoto non fa niente
    // (auto-close salta quando non trova una posizione scoperta); spenta su un mercato pieno abbandona
    // il capitale. I due errori non costano uguale.
    for (const [nome, lettore] of [
      ['lettore assente', undefined],
      ['lettura fallita', async () => ({ leggibile: false, aperta: null, error: 'venue muto' })],
      ['lettore che esplode', async () => { throw new Error('rete giu'); }],
    ]) {
      const m = mondo({ posizioneAperta: lettore });
      const r = await runAllocationReset({ rows: coppia(B) }, m.deps);
      ok(`${nome}: l uscita di A NON viene spenta`,
        !m.eventi.some((x) => x.e === 'uscita-OFF' && x.marketId === A)
        && r.spegnimento.uscitaTenutaAccesa.some((x) => x.marketId === A),
        r.spegnimento.uscitaTenutaAccesa[0] ? r.spegnimento.uscitaTenutaAccesa[0].perche.slice(0, 60) : 'nessuno');
    }
  }

  console.log('\n══ 6 · L ANTEPRIMA DICHIARA L USCITA E NON SCRIVE NIENTE');
  {
    const m = mondo({ posizioneAperta: async () => ({ leggibile: true, aperta: false }) });
    const r = await runAllocationReset({ rows: coppia(C), dryRunOnly: true }, m.deps);
    ok('nessuna scrittura dell uscita in anteprima', !m.eventi.some((x) => x.e === 'uscita-ON' || x.e === 'uscita-OFF'));
    ok('  ma il referto dice su quanti mercati la accenderebbe',
      r.accensione.uscitaAutomatica.length === 1 && r.accensione.uscitaAutomatica[0] === C,
      JSON.stringify(r.accensione.uscitaAutomatica));
    const p = r.log.find((x) => x.evento === 'completata');
    ok('  e il passo di anteprima la conta', p && p.accenderebbeUscitaAutomatica === 1, JSON.stringify(p && p.accenderebbeUscitaAutomatica));
  }

  console.log('\n══ 7 · I DUE PERCORSI LA CABLANO ENTRAMBI (automatico e manuale)');
  {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.resolve(__dirname, '..', '..');
    const ag = fs.readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    const rt = fs.readFileSync(path.join(ROOT, 'app', 'api', 'maker', 'manual', 'bulk-allocate', 'route.ts'), 'utf8');
    ok('il riallocatore automatico passa setAutoClose', /setAutoClose: \(\{ marketId, enabled, reason \}\)/.test(ag));
    ok('  e sa dire se c e una posizione aperta', /posizioneAperta: async \(\{ marketId \}\)/.test(ag));
    ok('il pannello manuale passa setAutoClose', /setAutoClose: \(\{ marketId, enabled, reason \}/.test(rt));
    ok('  e sa dire se c e una posizione aperta', /posizioneAperta: async \(\{ marketId \}/.test(rt));
    ok('entrambi incrociano le posizioni con i DUE token del mercato',
      /tokenId, .*tokenIdNo\]\.filter\(Boolean\)/.test(ag) && /tokenId, rules\?\.tokenIdNo\]\.filter\(Boolean\)/.test(rt));
    // ── L'ERRORE CHE IL TYPE CHECKER HA INTERCETTATO, E CHE QUI RESTA INTERCETTATO ────────────────
    // `resolveMarketRules` prende una STRINGA. Chiamandola con `{marketId}` restituisce regole non
    // leggibili, quindi nessun token, quindi «nessuna posizione trovata» — e l'uscita verrebbe SPENTA
    // proprio sul mercato che ne ha bisogno. E' l'errore piu' silenzioso possibile in questa catena.
    ok('resolveMarketRules e chiamata con la STRINGA, non con un oggetto',
      /resolveMarketRules\(marketId\)/.test(ag) && /resolveMarketRules\(marketId\)/.test(rt)
      && !/resolveMarketRules\(\{ marketId \}\)/.test(ag) && !/resolveMarketRules\(\{ marketId \}\)/.test(rt));
  }

  console.log(`\nuscita sempre accesa: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

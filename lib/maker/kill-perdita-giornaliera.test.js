#!/usr/bin/env node
'use strict';
// lib/maker/kill-perdita-giornaliera.test.js — IL KILL A −$100 CANCELLA, non rifiuta soltanto.
//
// ═══ IL DIFETTO ═════════════════════════════════════════════════════════════════════════════════════
// `maxDailyLossUsd` produceva un kill per utente (`risk-limits.js:175` → `adapter.js:793`), ma dentro
// `evaluateLimits`: cioe' **quando si valuta un ordine**. A libro pieno e senza ordini in arrivo, a −$100
// non succedeva niente. Era un gate di piazzamento con il nome di un kill.
//
// ═══ COSA SI PROVA ══════════════════════════════════════════════════════════════════════════════════
//   1 · il verdetto puro: scatta, non scatta, e i due modi di NON essere leggibile;
//   2 · la soglia e il numero vengono dalle STESSE funzioni del gate di piazzamento (per struttura);
//   3 · lo SCATTO arriva all'AZIONE: `poll()` del guardiano cancella e mette FERMA — provato guidando
//       il `poll` vero con dep iniettate, senza rete e senza toccare nessun file;
//   4 · le tre cose che NON fa: non tocca le posizioni, non scatta su una perdita non leggibile, non
//       dipende dalla lettura del venue (la perdita si legge dal registro, non dal book).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { valutaPerditaGiornaliera } = require('./kill-perdita-giornaliera');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};

console.log('\n══ 1 · IL VERDETTO PURO');
{
  const v = (p, s) => valutaPerditaGiornaliera({ perditaRealizzataUsd: p, sogliaUsd: s });
  ok('perdita oltre la soglia ⇒ SCATTA', v(-100, 100).scatta === true);
  ok('  e il confronto e\' `<= -soglia`, come `risk-limits.js:175`', v(-100.0, 100).scatta === true && v(-99.99, 100).scatta === false);
  ok('perdita entro la soglia ⇒ non scatta', v(-50, 100).scatta === false && v(-50, 100).leggibile === true);
  ok('un GUADAGNO non fa scattare niente', v(+250, 100).scatta === false);
  ok('perdita NON leggibile ⇒ non scatta, e lo dichiara',
    v(null, 100).scatta === false && v(null, 100).leggibile === false);
  ok('  e il motivo dice PERCHE\' la direzione e\' opposta a quella del gate',
    /non si cancella al buio/.test(v(null, 100).motivo));
  ok('soglia non leggibile ⇒ non scatta', v(-500, null).scatta === false && v(-500, 0).scatta === false);
  ok('zero perdita e zero soglia non scattano (una soglia a 0 non e\' una soglia)', v(0, 0).scatta === false);
}

console.log('\n══ 2 · LA SOGLIA E IL NUMERO VENGONO DAL GATE DI PIAZZAMENTO, NON DA UNA COPIA');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('il guardiano importa `resolveLimits` (la soglia)', /require\('\.\.\/lib\/safety\/risk-limits'\)/.test(src));
  ok('il guardiano importa `readUsage` (la perdita realizzata)', /require\('\.\.\/lib\/safety\/usage'\)/.test(src));
  ok('  e non ridichiara nessun numero di perdita giornaliera',
    !/maxDailyLossUsd\s*[:=]\s*[0-9]/.test(src) && !/perditaGiornaliera\s*=\s*[0-9]/.test(src));
  // La stessa grandezza, dallo stesso campo: se un domani `usage` rinominasse il campo, questo cade.
  const usage = fs.readFileSync(path.join(__dirname, '..', 'safety', 'usage.js'), 'utf8');
  ok('e il campo si chiama ancora `realisedDailyPnlUsd` in `usage`', /realisedDailyPnlUsd/.test(usage));
  ok('  e il guardiano legge QUEL campo', /realisedDailyPnlUsd/.test(src));
}

// ⚠ Da qui in giu' si `await`: il corpo sta in una funzione asincrona, perche' un `await` al livello
// piu' esterno renderebbe questo file un grafo ESM e `require()` lo rifiuterebbe.
(async () => {
console.log('\n══ 3 · LO SCATTO ARRIVA ALL\'AZIONE: SI CANCELLA E SI VA SU FERMA');
{
  const G = require(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-giornaliero-'));
  const stateFile = path.join(tmp, 'guardian-state.json');
  const scritti = [];
  let cancellato = null; let fermato = null;

  const base = {
    now: () => 1_700_000_000_000,
    stateFile, baselineFile: path.join(tmp, 'baseline.json'),
    stato: null,               // nessun latch
    scriviJson: (f, o) => { scritti.push({ f, o }); fs.writeFileSync(f, JSON.stringify(o)); },
    buildCancelCredsProviders: async () => ({}),
    cancelAllOrders: async () => { cancellato = true; return [{ venue: 'polymarket', ok: true, cancelled: 7, markets: [{ market: '0xabc', cancelled: 7 }] }]; },
    impostaBot: (a) => { fermato = a; return { ok: true, prima: true }; },
    registraCancellazione: () => ({ ok: true }),
    audit: () => {},
    // ⚠ IL VENUE SI STUBBA DOVE `capitaleOra` LO LEGGE DAVVERO: `poll` chiama `capitaleOra(deps)`, non
    // `deps.capitaleOra` — la prima stesura iniettava il nome sbagliato e il test faceva una lettura
    // VERA del saldo (visibile nei log: «riferimento fissato: $1495.26»). Quinta occorrenza della classe
    // «dep col nome sbagliato ⇒ valore di difetto che nessuno ha chiesto» (§5.3), e stavolta l'ha presa
    // il test su se stesso.
    saldo: { usd: 1000, affidabile: true, fonte: 'test', etaMs: 0 },
    posizioni: { readable: true, ageMs: 0, positions: [] },
  };

  // ① SCATTA: perdita −$120 contro soglia $100.
  const r = await G.poll({ ...base,
    resolveLimits: () => ({ readable: true, maxDailyLossUsd: 100 }),
    readUsage: () => ({ realisedDailyPnlUsd: -120 }),
  });
  ok('l\'azione dichiarata e\' `scattato-perdita-giornaliera`', r.azione === 'scattato-perdita-giornaliera', r.azione);
  ok('  e gli ordini a riposo sono stati CANCELLATI', cancellato === true);
  ok('  e il bot e\' stato messo su FERMA', fermato && fermato.enabled === false, fermato ? fermato.reason : '(non chiamato)');
  ok('  con il motivo che nomina la perdita giornaliera', /perdita giornaliera realizzata/.test((fermato && fermato.reason) || ''));
  ok('  il latch e\' scritto e dichiara la causa', (() => {
    const l = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return l.scattato === true && l.causa === 'perdita-giornaliera' && l.perditaRealizzataUsd === -120 && l.sogliaPerditaGiornalieraUsd === 100;
  })());
  ok('  e il numero e il tetto sono nel referto restituito', r.perditaRealizzataUsd === -120 && r.sogliaUsd === 100);
  // ⚠ LA PROPRIETA' CHE CONTA PER LA GIORNATA IN CUI IL VENUE FA I CAPRICCI: lo scatto per perdita
  // realizzata non passa dal venue. Si prova col FATTO che il baseline non e' stato creato — `poll` lo
  // crea al primo giro in cui legge un capitale valido, quindi la sua assenza dice che quel ramo non e'
  // stato raggiunto — e per struttura, che il blocco sta PRIMA della lettura.
  ok('  e non ha nemmeno creato il baseline: il ramo del venue non e\' stato raggiunto',
    !fs.existsSync(path.join(tmp, 'baseline.json')));
  ok('  e per struttura il controllo sta PRIMA della lettura del capitale', (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8');
    return src.indexOf('valutaPerditaGiornaliera({') < src.indexOf('if (!capitale) capitale = await capitaleOra(deps)');
  })());

  // ② NON scatta: perdita non leggibile. E il giro prosegue col guardiano di sempre.
  cancellato = null; fermato = null;
  fs.unlinkSync(stateFile);
  const r2 = await G.poll({ ...base,
    resolveLimits: () => ({ readable: true, maxDailyLossUsd: 100 }),
    readUsage: () => ({ realisedDailyPnlUsd: null }),
  });
  ok('perdita non leggibile ⇒ NESSUNA cancellazione', cancellato === null && fermato === null);
  ok('  e il giro passa al guardiano del drawdown, che il venue lo legge',
    r2.azione !== 'scattato-perdita-giornaliera', r2.azione);
  ok('  e infatti il baseline ADESSO esiste (il ramo del venue e\' stato raggiunto)',
    fs.existsSync(path.join(tmp, 'baseline.json')));

  // ③ NON scatta: soglia non leggibile.
  cancellato = null;
  const r3 = await G.poll({ ...base,
    resolveLimits: () => ({ readable: false, maxDailyLossUsd: null }),
    readUsage: () => ({ realisedDailyPnlUsd: -5000 }),
  });
  ok('soglia non leggibile ⇒ NESSUNA cancellazione, nemmeno a −$5000',
    cancellato === null && r3.azione !== 'scattato-perdita-giornaliera');

  // ④ Un'eccezione nella lettura non deve poter cancellare niente.
  cancellato = null;
  const r4 = await G.poll({ ...base,
    resolveLimits: () => { throw new Error('registro illeggibile'); },
    readUsage: () => ({ realisedDailyPnlUsd: -900 }),
  });
  ok('un\'eccezione nella lettura ⇒ nessuna cancellazione e il giro prosegue',
    cancellato === null && r4.azione !== 'scattato-perdita-giornaliera');

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n══ 4 · LE POSIZIONI NON SI TOCCANO, E L\'AZIONE E\' SCRITTA UNA VOLTA SOLA');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8');
  const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  // Il guardiano non ha nessuna superficie che venda: la sua unica scrittura al venue e' la spazzata.
  ok('nessun percorso di piazzamento o vendita nel guardiano',
    !/placeManualOrder|placeOrder|runBulkAllocation|postOrder/.test(codice));
  // ⚠ UNA SOLA AZIONE PER DUE INGRESSI: se `cancelAllOrders` comparisse due volte, le due spazzate
  // potrebbero divergere su cosa cancellano — ed e' l'unica funzione del repo che tocca TUTTI i venue.
  const quante = (codice.match(/cancelAllOrders\)\(/g) || []).length;
  ok('la spazzata e\' chiamata da UN SOLO punto', quante === 1, `${quante} chiamate`);
  ok('  e i due ingressi passano dalla stessa funzione', (codice.match(/await spazzaEFerma\(/g) || []).length === 2);
  ok('e FERMA resta DOPO la cancellazione (l\'ordine inverso lascia il libro pieno a bot fermo)',
    codice.indexOf('cancelAllOrders)(') < codice.indexOf('impostaBot)('));
}

console.log(`\nkill per perdita giornaliera: ${pass} passati, ${fail} falliti\n`);
  assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
})().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });

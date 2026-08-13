'use strict';
// lib/maker/guardian-perdite.test.js — LA DECISIONE DEL GUARDIANO, ESERCITATA SENZA VENUE.
//
// Questo guardiano cancella ordini VERI e ferma il bot. Quindi ogni ramo che porta a quello scatto —
// soglie, confini esatti, letture fallite, latch — si prova qui, con dati finti, e senza che una sola
// chiamata esca dal processo. Nessun test tocca il venue, il disco di produzione o lo stato reale.

const assert = require('assert');
const path = require('path');
const G = require('./guardian-perdite');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { console.log('  ✓ ' + nome + (extra !== undefined ? ` — ${extra}` : '')); passati++; }
  else { console.log('  ✗ ' + nome + (extra !== undefined ? ` — ${extra}` : '')); falliti++; }
}

console.log('\n── 1 · VALUTAZIONE DEL CAPITALE');
{
  // Il caso calcolato a mano, quello contro cui si misura tutto il resto:
  //   saldo            $588.264868
  //   144.2 share NO × $0.5155 = $74.3351   (144.2 × 5155 = 743351, /10⁴)
  //   20 share YES     × $0.30  = $6.00
  //   totale atteso    588.264868 + 80.3351 = $668.599968
  const c = G.valutaCapitale({
    saldoUsd: 588.264868,
    posizioniLeggibili: true,
    posizioni: [
      { tokenId: '796110227', conditionId: '0xc16f', size: 144.2, curPrice: 0.5155 },
      { tokenId: '966897743', conditionId: '0xc16f', size: 20, curPrice: 0.30 },
    ],
  });
  ok('leggibile', c.leggibile === true);
  ok('valore posizioni = 144.2×0.5155 + 20×0.30 = 80.3351', Math.abs(c.valorePosizioniUsd - 80.3351) < 1e-6, c.valorePosizioniUsd);
  ok('totale = saldo + posizioni = 668.599968', Math.abs(c.totaleUsd - 668.599968) < 1e-6, c.totaleUsd);
  ok('il dettaglio porta una riga per posizione', c.posizioni.length === 2);
}
{
  const c = G.valutaCapitale({ saldoUsd: 100, posizioniLeggibili: true, posizioni: [] });
  ok('nessuna posizione, snapshot leggibile → lo zero è REALE', c.leggibile === true && c.valorePosizioniUsd === 0 && c.totaleUsd === 100);
}
{
  const c = G.valutaCapitale({ saldoUsd: null, posizioniLeggibili: true, posizioni: [] });
  ok('saldo illeggibile → totale null, MAI zero', c.leggibile === false && c.totaleUsd === null);
  ok('  e lo dice', /saldo pUSD non leggibile/.test(c.motivo));
}
{
  const c = G.valutaCapitale({ saldoUsd: 100, posizioniLeggibili: false, posizioni: null });
  ok('snapshot posizioni vecchio → totale null, non «nessuna posizione»', c.leggibile === false && c.totaleUsd === null);
}
{
  const c = G.valutaCapitale({ saldoUsd: 100, posizioniLeggibili: true, posizioni: [{ tokenId: 'x', size: 10, curPrice: null }] });
  ok('una posizione senza prezzo corrente → totale null, non vale zero dollari', c.leggibile === false && c.totaleUsd === null);
}

console.log('\n── 2 · PnL');
{
  const p = G.calcolaPnl({ baselineUsd: 1000, totaleUsd: 940 });
  ok('perdita di 60 su 1000 → −60 USD e −6%', p.pnlUsd === -60 && Math.abs(p.pnlPct + 6) < 1e-9, `${p.pnlUsd} / ${p.pnlPct}%`);
  const g = G.calcolaPnl({ baselineUsd: 1000, totaleUsd: 1025 });
  ok('guadagno → segno positivo', g.pnlUsd === 25 && Math.abs(g.pnlPct - 2.5) < 1e-9);
  ok('capitale non leggibile → non calcolabile', G.calcolaPnl({ baselineUsd: 1000, totaleUsd: null }).calcolabile === false);
  ok('baseline assente → non calcolabile', G.calcolaPnl({ baselineUsd: null, totaleUsd: 900 }).calcolabile === false);
  const z = G.calcolaPnl({ baselineUsd: 0, totaleUsd: -5 });
  ok('baseline zero → nessuna percentuale (niente Infinity), ma l\'assoluto resta', z.calcolabile === true && z.pnlPct === null && z.pnlUsd === -5);
}

console.log('\n── 3 · LE SOGLIE, E I LORO CONFINI ESATTI');
const pnlDa = (base, tot) => G.calcolaPnl({ baselineUsd: base, totaleUsd: tot });
{
  // Soglie di default: −5% e −$30.
  ok('perdita piccola → non scatta', G.decidiScatto({ pnl: pnlDa(1000, 990), sogliaPct: 5, sogliaAbs: 30 }).scatta === false);

  // −$30 esatti su 1000 = −3%: scatta per la soglia ASSOLUTA soltanto.
  const soloAbs = G.decidiScatto({ pnl: pnlDa(1000, 970), sogliaPct: 5, sogliaAbs: 30 });
  ok('−$30 esatti → scatta (il confine è incluso)', soloAbs.scatta === true);
  ok('  e solo per la soglia assoluta', soloAbs.soglieSuperate.length === 1 && soloAbs.soglieSuperate[0].soglia === 'assoluta');

  // −5% esatti su 100 = −$5: scatta per la PERCENTUALE soltanto.
  const soloPct = G.decidiScatto({ pnl: pnlDa(100, 95), sogliaPct: 5, sogliaAbs: 30 });
  ok('−5% esatti → scatta (il confine è incluso)', soloPct.scatta === true);
  ok('  e solo per la soglia percentuale', soloPct.soglieSuperate.length === 1 && soloPct.soglieSuperate[0].soglia === 'percentuale');

  // Appena sopra il confine, in entrambe le direzioni: NON scatta.
  ok('−$29.99 → non scatta', G.decidiScatto({ pnl: pnlDa(1000, 970.01), sogliaPct: 5, sogliaAbs: 30 }).scatta === false);
  ok('−4.99% → non scatta', G.decidiScatto({ pnl: pnlDa(100, 95.01), sogliaPct: 5, sogliaAbs: 30 }).scatta === false);

  // Entrambe insieme.
  const due = G.decidiScatto({ pnl: pnlDa(500, 440), sogliaPct: 5, sogliaAbs: 30 });
  ok('−$60 su 500 (−12%) → entrambe le soglie', due.scatta === true && due.soglieSuperate.length === 2);

  // LA REGOLA CHE CONTA: al buio non si scatta.
  const cieco = G.decidiScatto({ pnl: G.calcolaPnl({ baselineUsd: 1000, totaleUsd: null }), sogliaPct: 5, sogliaAbs: 30 });
  ok('capitale non leggibile → NON scatta (un saldo illeggibile non è una perdita del 100%)', cieco.scatta === false);
  ok('  e il motivo lo dice', /non si scatta su un numero che non si è letto/.test(cieco.motivo));

  // Le soglie si scrivono positive nel .env; un segno sbagliato non deve invertire la logica.
  ok('soglie scritte negative per errore → stesso comportamento', G.decidiScatto({ pnl: pnlDa(1000, 970), sogliaPct: -5, sogliaAbs: -30 }).scatta === true);
}

console.log('\n── 4 · BASELINE');
{
  const cap = G.valutaCapitale({ saldoUsd: 500, posizioniLeggibili: true, posizioni: [{ tokenId: 'a', size: 10, curPrice: 0.5 }] });
  const b = G.baselineDaScrivere({ capitale: cap, now: 1_786_000_000_000, motivo: 'primo avvio' });
  ok('il baseline porta il totale', b.baselineUsd === 505);
  ok('  con la data leggibile', b.atIso === new Date(1_786_000_000_000).toISOString());
  const r = G.leggiBaseline(b);
  ok('e si rilegge', r.valido === true && r.baselineUsd === 505);
  ok('un file assente → nessun baseline', G.leggiBaseline(null).valido === false);
  ok('un file senza numero → nessun baseline (va ricreato)', G.leggiBaseline({ baselineUsd: 'boh' }).valido === false);
}

console.log('\n── 5 · IL REFERTO');
{
  const { costruisciCancellazione } = require('./cancellazione-di-emergenza');
  const results = [{
    venue: 'polymarket', ok: true, cancelled: 3, venueOpenBefore: 3, simulated: false, notionalUsd: 120.5,
    markets: [{ market: '0xaaa', cancelled: 2, notionalUsd: 80, ok: true }, { market: '0xbbb', cancelled: 1, notionalUsd: 40.5, ok: true }],
  }];
  const at = 1_786_100_000_000;
  const cap = G.valutaCapitale({ saldoUsd: 900, posizioniLeggibili: true, posizioni: [{ tokenId: 'a', size: 100, curPrice: 0.4 }] });
  const pnl = G.calcolaPnl({ baselineUsd: 1000, totaleUsd: cap.totaleUsd });
  const dec = G.decidiScatto({ pnl, sogliaPct: 5, sogliaAbs: 30 });
  const ev = G.costruisciEventoGuardian({
    base: costruisciCancellazione({ at, results, ambito: 'tutto' }),
    at, pnl, capitale: cap, baseline: { baselineUsd: 1000, atIso: '2026-08-07T00:00:00.000Z' },
    soglieSuperate: dec.soglieSuperate, sogliaPct: 5, sogliaAbs: 30, botFermato: true,
  });
  ok('reason = guardian-auto-kill', ev.reason === 'guardian-auto-kill');
  ok('id distinto da quello del dead-man', ev.id === `guardian-${at}` && !/^deadman-/.test(ev.id));
  ok('porta il PnL assoluto', ev.guardian.pnlUsd === -60, ev.guardian.pnlUsd);
  ok('porta il PnL percentuale', Math.abs(ev.guardian.pnlPct + 6) < 1e-9, ev.guardian.pnlPct);
  // −60 su 1000 e' −6%: supera SIA la percentuale (−5%) SIA l'assoluta (−$30).
  ok('dice QUALE soglia: qui entrambe', ev.guardian.scattataPer === 'entrambe' && ev.guardian.soglieSuperate.length === 2);
  ok('porta il numero di ordini cancellati', ev.ordiniCancellati === 3);
  ok('porta i mercati coinvolti', ev.venues[0].markets.map((m) => m.market).join(',') === '0xaaa,0xbbb');
  ok('porta il capitale liberato', ev.capitaleUsd === 120.5);
  ok('dice che il bot è stato fermato', ev.guardian.botFermato === true);
  ok('i campi del dead-man che qui non hanno senso restano null, non presi a prestito',
    ev.stalenessSec === null && ev.thresholdSec === null && ev.heartbeatAt === null);
  ok('porta le posizioni al momento dello scatto', ev.guardian.posizioniAlloScatto.length === 1);

  // Due referti nello stesso registro devono restare distinguibili.
  const deadman = costruisciCancellazione({ at, stalenessSec: 121, thresholdSec: 120, results, ambito: 'tutto' });
  ok('dead-man e guardian hanno id diversi allo STESSO istante', deadman.id !== ev.id, `${deadman.id} vs ${ev.id}`);
  ok('  e il dead-man non ha reason=guardian-auto-kill', deadman.reason === undefined);
}

console.log('\n── 6 · ISOLAMENTO: QUESTO GUARDIANO NON PUÒ PIAZZARE');
{
  const fs = require('fs');
  const visti = new Set(); const piazzamento = [];
  (function walk(f, depth) {
    if (depth > 8 || visti.has(f)) return;
    visti.add(f);
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let r = path.resolve(path.dirname(f), m[1]);
      if (!r.endsWith('.js')) r += '.js';
      if (/polymarket-clob-maker[/\\](adapter|signer|orders|manual-order)/.test(r)) piazzamento.push(`${path.basename(f)} → ${m[1]}`);
      walk(r, depth + 1);
    }
  })(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 0);
  ok(`nessun adapter di piazzamento nell'albero di agent43-guardian (${visti.size} moduli visitati)`,
    piazzamento.length === 0, piazzamento.join(' · '));

  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8');
  const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const proibito of ['signTypedData', 'postOrder', 'createOrder', 'placeManualOrder', 'replaceManualOrder', 'sendTransaction']) {
    ok(`nessuna chiamata a ${proibito} nel codice eseguibile`, !new RegExp(`\\b${proibito}\\s*\\(`).test(codice));
  }
  ok('l\'unica superficie verso il venue è cancel-all', /require\('\.\.\/lib\/maker\/cancel-all'\)/.test(src));
}

console.log('\n── 7 · IL GIRO COMPLETO, CON VENUE E DISCO FINTI');
(async () => {
  const A = require('../../agents/agent43-guardian');
  const fsx = require('fs');
  const NOW = 1_786_200_000_000;
  const scritture = new Map();

  // ── OGNI WRITER È INIETTATO, IN OGNI CASO ─────────────────────────────────────────────────────
  // La prima stesura iniettava solo `cancelAllOrders` nei casi che non dovevano scattare, «tanto non
  // scattano». Poi uno di quei casi è scattato davvero — era il bug di `Number(null)` — ed essendo gli
  // altri writer NON iniettati, il test è uscito sui veri: ha scritto data/maker-bot-enabled.json (con
  // un motivo inventato, «−100%») e un referto fasullo in data/cancellazioni-di-emergenza.json.
  //
  // Nessun capitale è stato toccato, perché `cancelAllOrders` era finto. Ma è stata fortuna, non
  // struttura: la lezione è che un test che si affida a «tanto quel ramo non viene preso» non è un
  // test isolato, è un test che non ha ancora fallito. Adesso i writer stanno in `baseDeps`, quindi
  // valgono per OGNI caso, compresi quelli che non dovrebbero mai arrivarci.
  const baseDeps = {
    now: () => NOW,
    scriviJson: (f, o) => scritture.set(path.basename(f), o),
    soglie: { pct: 5, abs: 30 },
    saldo: { usd: 940, affidabile: true },
    posizioni: { readable: true, positions: [] },
    buildCancelCredsProviders: async () => ({}),
    cancelAllOrders: async () => { throw new Error('cancelAllOrders non iniettato in questo caso: il test NON deve poter cancellare'); },
    impostaBot: () => { throw new Error('impostaBot non iniettato in questo caso: il test NON deve poter toccare l\'interruttore vero'); },
    registraCancellazione: () => { throw new Error('registraCancellazione non iniettato: il test NON deve poter scrivere nel registro vero'); },
  };

  // I due file di produzione che la prima stesura ha toccato. Si fotografa il loro stato PRIMA e lo si
  // riconfronta DOPO: se un giorno qualcuno rimuove un'iniezione, questo test lo dice invece di
  // lasciarlo scoprire a chi legge `git status`.
  const FILE_PROD = ['maker-bot-enabled.json', 'cancellazioni-di-emergenza.json']
    .map((n) => path.join(__dirname, '..', '..', 'data', n));
  const impronta = () => FILE_PROD.map((f) => { try { const s = fsx.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return 'assente'; } }).join('|');
  const primaDelTest = impronta();

  {
    // Baseline assente → si crea, e NON si scatta al primo giro.
    const r = await A.poll({ ...baseDeps, baselineRaw: null, stato: null });
    ok('primo avvio → crea il baseline e non scatta', r.azione === 'baseline-creato' && r.baselineUsd === 940);
    ok('  scritto su guardian-baseline.json', scritture.has('guardian-baseline.json'));
  }
  {
    // Baseline presente, perdita entro soglia.
    const r = await A.poll({ ...baseDeps, baselineRaw: { baselineUsd: 950 }, stato: null });
    ok('perdita di $10 su 950 → entro soglia, nessuna azione', r.azione === 'entro-soglia' && r.pnlUsd === -10);
  }
  {
    // Perdita oltre soglia → scatta: cancella, ferma il bot, deposita il referto.
    //
    // ⚠ SERVONO DUE LETTURE, DAL 13 AGOSTO 2026. La prima è un PRE-ALLARME e non scatta: vedi
    // `LETTURE_CONSECUTIVE_PER_SCATTO` in guardian-perdite.js. Il 13 agosto il guardiano ha latchato
    // su −$36,15 che trenta secondi dopo valevano −$6,77, e la sequenza mostrava un transitorio
    // identico rientrato da solo tre minuti prima. Il test guida quindi la sequenza vera invece di
    // una lettura sola — e la prima asserzione qui sotto è che UNA lettura NON basta.
    let cancellato = false; let fermato = null; let referto = null;
    const deps60 = {
      ...baseDeps, baselineRaw: { baselineUsd: 1000 },
      buildCancelCredsProviders: async () => ({}),
      cancelAllOrders: async () => { cancellato = true; return [{ venue: 'polymarket', ok: true, cancelled: 2, venueOpenBefore: 2, simulated: false, notionalUsd: 50, markets: [{ market: '0xaaa', cancelled: 2, notionalUsd: 50, ok: true }] }]; },
      impostaBot: (a) => { fermato = a; return { ok: true, prima: true, ora: false }; },
      registraCancellazione: (e) => { referto = e; return { ok: true, written: true, count: 1 }; },
    };
    const primo = await A.poll({ ...deps60, stato: null, statoConferme: null });
    ok('perdita di $60 su 1000 → la PRIMA lettura è un pre-allarme, non uno scatto',
      primo.azione === 'pre-allarme' && primo.conferme === 1);
    ok('  e non ha cancellato niente', cancellato === false && fermato === null);
    const r = await A.poll({ ...deps60, stato: null, statoConferme: primo.statoConferme });
    ok('perdita di $60 su 1000 → SCATTA alla SECONDA lettura consecutiva', r.azione === 'scattato');
    ok('  ha cancellato usando la funzione condivisa', cancellato === true);
    ok('  ha messo il bot su FERMA con enabled:false', fermato && fermato.enabled === false);
    ok('  attribuendolo a se stesso', fermato && fermato.by === 'agent43-guardian');
    ok('  ha depositato il referto con reason=guardian-auto-kill', referto && referto.reason === 'guardian-auto-kill');
    ok('  con gli ordini cancellati', referto && referto.ordiniCancellati === 2);
    ok('  e ha scritto la latch', scritture.get('guardian-state.json') && scritture.get('guardian-state.json').scattato === true);
  }
  {
    // La latch: già scattato ⇒ non si rifà niente, nemmeno con una perdita enorme.
    let cancellato = false;
    const r = await A.poll({
      ...baseDeps, baselineRaw: { baselineUsd: 100000 }, stato: { scattato: true, atIso: 'x' },
      cancelAllOrders: async () => { cancellato = true; return []; },
    });
    ok('già scattato → nessuna seconda spazzata (niente auto-riarmo, niente lotta con l\'operatore)',
      r.azione === 'gia-scattato' && cancellato === false);
  }
  {
    // Capitale illeggibile con baseline presente: NON si scatta.
    let cancellato = false;
    const r = await A.poll({
      ...baseDeps, saldo: { usd: null, affidabile: false }, baselineRaw: { baselineUsd: 1000 }, stato: null,
      cancelAllOrders: async () => { cancellato = true; return []; },
    });
    ok('saldo illeggibile → nessuno scatto, nessuna cancellazione', r.azione === 'capitale-illeggibile' && cancellato === false);
  }
  {
    // Snapshot posizioni vecchio: idem.
    const r = await A.poll({ ...baseDeps, posizioni: { readable: false, positions: [] }, baselineRaw: { baselineUsd: 1000 }, stato: null });
    ok('snapshot posizioni vecchio → nessuno scatto', r.azione === 'capitale-illeggibile');
  }
  {
    // Baseline da creare ma capitale illeggibile: non si fissa un punto zero su una lettura fallita.
    const r = await A.poll({ ...baseDeps, saldo: { usd: null, affidabile: false }, baselineRaw: null, stato: null });
    ok('baseline da creare con capitale illeggibile → si aspetta, non si inventa', r.azione === 'attesa-baseline');
  }

  ok('nessun file di produzione toccato dal test', impronta() === primaDelTest,
    impronta() === primaDelTest ? undefined : `PRIMA ${primaDelTest} → DOPO ${impronta()}`);

  console.log('');
  if (falliti === 0) console.log(`TUTTI VERDI: ${passati} passati, 0 falliti`);
  else { console.log(`FALLITI: ${falliti} su ${passati + falliti}`); process.exitCode = 1; }
  assert.ok(falliti === 0);
})();

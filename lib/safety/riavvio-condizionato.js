'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  IL RIAVVIO AUTOMATICO CONDIZIONATO — le modifiche vanno live da sole, la rete di sicurezza resta
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IL PROBLEMA. Ogni correzione resta inattiva finché un umano non autorizza un riavvio, e l'operatore
 * non può seguire il bot. Nella sola giornata del 13 agosto 2026 sono rimaste inattive per ore: la
 * griglia del piano, la sentinella sul vuoto, il recupero della scadenza, la coerenza delle soglie,
 * l'esenzione del tetto sulle chiusure. Il codice era in `main` e il bot girava su quello vecchio.
 *
 * ═══ LE QUATTRO CONDIZIONI, TUTTE INSIEME ══════════════════════════════════════════════════════════
 * Il riavvio parte **solo se** valgono tutte e quattro. Se anche una manca **non si riavvia**, la
 * modifica resta inattiva e lo si scrive in modo evidente: un riavvio fatto a metà delle condizioni è
 * peggio di un riavvio non fatto, perché sposta il codice sotto il capitale senza le prove.
 *
 *  ① **suite senza rossi NUOVI rispetto alla baseline** — non «zero rossi»: nove sono preesistenti e
 *    dipendono dai dati vivi, pretendere zero significherebbe non riavviare mai. Si confronta l'INSIEME
 *    dei nomi, non il conteggio: nove rossi diversi dai nove noti sono nove regressioni.
 *  ② **`npm run build` verde** — un `.next` incompleto manda il dashboard in crash loop (§5.3).
 *  ③ **KILL spento** — con il kill attivo l'operatore ha deciso che nulla si muove, e un riavvio
 *    automatico sarebbe una decisione presa contro la sua.
 *  ④ **nessuna posizione scoperta sopra il minimo del venue** — è la condizione che protegge il
 *    capitale: riavviare mentre una posizione copribile è scoperta significa togliere il presidio
 *    proprio a chi ne ha bisogno. Sotto il minimo invece è uno stato che nessun ciclo può risolvere
 *    (§5 p.123), e aspettarlo vorrebbe dire non riavviare mai.
 *
 * ⚠ **UNA CONDIZIONE NON VERIFICABILE VALE «NO».** Snapshot posizioni scaduto, kill illeggibile, suite
 * che non produce un esito ⇒ non si riavvia. Non si approssima: l'incognita non è un via libera, qui
 * come in tutto il resto di questo repo.
 *
 * ═══ SEQUENZIALE, MAI SIMULTANEO ═══════════════════════════════════════════════════════════════════
 * Un agent per volta, e **dopo ognuno si verifica che sia tornato online e stabile** prima di passare
 * al successivo. Se uno non torna su **ci si ferma**: gli altri restano sul codice vecchio, che è uno
 * stato coerente e funzionante, invece di lasciare il book senza presidio in mezzo a una cascata.
 * L'ordine è `agent24` → `agent41` → `agent40`: dal più lontano dal capitale al più vicino, così se la
 * cascata si interrompe è il presidio degli ordini vivi l'ultimo a essere toccato.
 *
 * Modulo **puro** nella parte che decide. La suite, il build, pm2 e l'orologio arrivano iniettati:
 * questo file non esegue niente da solo, e non può riavviare nulla se nessuno gli passa il comando.
 */

const fin = (v) => Number.isFinite(v);

/** I nove rossi preesistenti al 13 agosto 2026. Si confronta l'INSIEME, non il numero. */
const BASELINE_ROSSI = Object.freeze([
  'lib/leg-order.test.js',
  'lib/maker/dipendenze-collegate.test.js',
  'lib/maker/end-of-scale-cycle.test.js',
  'lib/maker/scaduto-senza-rinnovo.test.js',
  'lib/rewards/categoria-mercato.test.js',
  'lib/rewards/scadenza-ereditata.test.js',
  'lib/rewards/velocita-mercato.test.js',
  'lib/venues/__tests__/discriminates.test.js',
  'lib/venues/__tests__/fail-closed.test.js',
]);

/** L'ordine del riavvio: dal più lontano dal capitale al più vicino. */
const ORDINE = Object.freeze(['agent24-liquidity-rewards', 'agent41-realloc-scheduler', 'agent40-manual-reprice']);

/**
 * LE CONDIZIONI. Restituisce sempre l'elenco completo con l'esito di ognuna, anche quando la prima
 * fallisce: chi legge il giornale deve poter vedere *quali* mancavano, non solo che qualcosa mancava.
 *
 * @param suite      `{eseguita:boolean, rossi:string[]}` — `eseguita:false` ⇒ condizione NON verificata
 * @param build      `{verde:boolean}`
 * @param kill       `{effectivelyKilled:boolean, readable:boolean}`
 * @param posizioni  `{readable:boolean, scoperteSopraMinimo:number}`
 */
function valutaCondizioni({ suite = null, build = null, kill = null, posizioni = null, baseline = BASELINE_ROSSI } = {}) {
  const c = [];

  // ① la suite
  if (!suite || suite.eseguita !== true || !Array.isArray(suite.rossi)) {
    c.push({ nome: 'suite', ok: false, motivo: 'la suite non ha prodotto un esito leggibile: non si riavvia su un\'incognita' });
  } else {
    const noti = new Set(baseline);
    const nuovi = suite.rossi.filter((r) => !noti.has(r));
    c.push(nuovi.length === 0
      ? { nome: 'suite', ok: true, motivo: `${suite.rossi.length} rossi, tutti preesistenti` }
      : { nome: 'suite', ok: false, motivo: `${nuovi.length} rosso/i NUOVO/I: ${nuovi.join(', ')}` });
  }

  // ② il build
  c.push(build && build.verde === true
    ? { nome: 'build', ok: true, motivo: 'npm run build verde' }
    : { nome: 'build', ok: false, motivo: (build && build.motivo) || 'build non verde o non eseguito' });

  // ③ il kill
  if (!kill || kill.readable !== true) {
    c.push({ nome: 'kill', ok: false, motivo: 'kill-switch non leggibile: vale come ATTIVO' });
  } else {
    c.push(kill.effectivelyKilled === true
      ? { nome: 'kill', ok: false, motivo: 'KILL ATTIVO: l\'operatore ha deciso che nulla si muove' }
      : { nome: 'kill', ok: true, motivo: 'KILL spento' });
  }

  // ④ le posizioni scoperte sopra il minimo
  if (!posizioni || posizioni.readable !== true || !fin(posizioni.scoperteSopraMinimo)) {
    c.push({ nome: 'posizioni', ok: false, motivo: 'posizioni scoperte non verificabili: non si riavvia al buio' });
  } else {
    c.push(posizioni.scoperteSopraMinimo === 0
      ? { nome: 'posizioni', ok: true, motivo: 'nessuna posizione scoperta sopra il minimo del venue' }
      : { nome: 'posizioni', ok: false, motivo: `${posizioni.scoperteSopraMinimo} posizione/i scoperta/e SOPRA il minimo: il presidio non si toglie adesso` });
  }

  const mancanti = c.filter((x) => !x.ok);
  return {
    ok: mancanti.length === 0,
    condizioni: c,
    mancanti: mancanti.map((x) => x.nome),
    riga: mancanti.length === 0
      ? '✅ tutte e quattro le condizioni sono soddisfatte: si riavvia'
      : `⛔ RIAVVIO AUTOMATICO NON ESEGUITO — la modifica resta INATTIVA. Mancano: ${mancanti.map((x) => `${x.nome} (${x.motivo})`).join(' · ')}`,
  };
}

/**
 * LA CASCATA. Un agent per volta; dopo ognuno si verifica che sia tornato **online e stabile** prima di
 * passare al successivo, e al primo che non torna su ci si ferma.
 *
 * @param riavvia   `async (nome) => void`
 * @param stato     `async (nome) => {online:boolean, pid:number, uptimeMs:number, restarts:number}`
 * @param attende   `async (ms) => void`
 * @param audit     `(record) => void`
 */
async function riavviaInSequenza({
  agenti = ORDINE, riavvia = null, stato = null, attende = null, audit = null,
  commit = null, condizioni = null, now = Date.now(), stabileMs = 15_000,
} = {}) {
  const fatti = [];
  if (typeof riavvia !== 'function' || typeof stato !== 'function') {
    return { ok: false, fatti, motivo: 'nessun esecutore iniettato: questo modulo non riavvia niente da solo' };
  }
  for (const nome of agenti) {
    let prima = null;
    try { prima = await stato(nome); } catch { prima = null; }
    try { await riavvia(nome); } catch (e) {
      fatti.push({ agent: nome, ok: false, motivo: `comando di riavvio fallito: ${e && e.message}` });
      return { ok: false, fatti, motivo: `${nome} non e' stato riavviato: la cascata si ferma qui, gli altri restano sul codice vecchio` };
    }
    if (typeof attende === 'function') await attende(stabileMs);
    let dopo = null;
    try { dopo = await stato(nome); } catch { dopo = null; }
    // «Tornato su» non basta: deve essere ONLINE e con un uptime che dica che non sta rimbalzando.
    const su = !!(dopo && dopo.online === true && fin(dopo.uptimeMs) && dopo.uptimeMs >= stabileMs * 0.5);
    const rimbalza = !!(dopo && prima && fin(dopo.restarts) && fin(prima.restarts) && (dopo.restarts - prima.restarts) > 1);
    const ok = su && !rimbalza;
    fatti.push({ agent: nome, ok, pid: dopo && dopo.pid, restarts: dopo && dopo.restarts,
      motivo: ok ? 'online e stabile' : (rimbalza ? 'sta rimbalzando: piu\' di un riavvio in questa finestra' : 'non e\' tornato online entro la finestra') });
    if (typeof audit === 'function') {
      try {
        audit({ ts: now, venue: 'polymarket', source: 'riavvio-condizionato', op: 'riavvio-automatico',
          reason: 'commit su main con tutte le condizioni soddisfatte',
          outcome: ok ? 'riavviato' : 'riavvio-fallito',
          requested: { agent: nome, commit },
          observed: { pid: dopo && dopo.pid, restarts: dopo && dopo.restarts, condizioni } });
      } catch { /* l'audit non ferma la cascata */ }
    }
    if (!ok) {
      return { ok: false, fatti, motivo: `${nome} non e' tornato su: la cascata si ferma, gli agent successivi NON vengono riavviati` };
    }
  }
  return { ok: true, fatti, motivo: `${fatti.length} agent riavviati in sequenza, tutti online e stabili` };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) p += 1; else { f += 1; console.error('  ✗', n); } };
  const buone = {
    suite: { eseguita: true, rossi: [...BASELINE_ROSSI] },
    build: { verde: true },
    kill: { effectivelyKilled: false, readable: true },
    posizioni: { readable: true, scoperteSopraMinimo: 0 },
  };

  ok('tutte e quattro soddisfatte ⇒ si riavvia', valutaCondizioni(buone).ok === true);
  ok('un rosso NUOVO ferma tutto', (() => {
    const v = valutaCondizioni({ ...buone, suite: { eseguita: true, rossi: [...BASELINE_ROSSI, 'lib/maker/nuovo.test.js'] } });
    return v.ok === false && /NUOVO/.test(v.condizioni[0].motivo);
  })());
  ok('  ma i nove preesistenti NON fermano niente', valutaCondizioni(buone).condizioni[0].ok === true);
  ok('  e MENO rossi del previsto va benissimo', valutaCondizioni({ ...buone, suite: { eseguita: true, rossi: ['lib/leg-order.test.js'] } }).ok === true);
  ok('build non verde ferma tutto', valutaCondizioni({ ...buone, build: { verde: false } }).ok === false);
  ok('KILL attivo ferma tutto', valutaCondizioni({ ...buone, kill: { effectivelyKilled: true, readable: true } }).ok === false);
  ok('KILL illeggibile vale ATTIVO', valutaCondizioni({ ...buone, kill: { readable: false } }).ok === false);
  ok('una posizione scoperta sopra il minimo ferma tutto',
    valutaCondizioni({ ...buone, posizioni: { readable: true, scoperteSopraMinimo: 1 } }).ok === false);
  ok('  ma quelle SOTTO il minimo non fermano niente (nessun ciclo può risolverle)',
    valutaCondizioni({ ...buone, posizioni: { readable: true, scoperteSopraMinimo: 0 } }).ok === true);
  ok('posizioni non verificabili ⇒ non si riavvia', valutaCondizioni({ ...buone, posizioni: { readable: false } }).ok === false);
  ok('suite non eseguita ⇒ non si riavvia', valutaCondizioni({ ...buone, suite: { eseguita: false } }).ok === false);
  ok('l\'elenco delle condizioni è SEMPRE completo, anche quando la prima fallisce',
    valutaCondizioni({ ...buone, build: { verde: false } }).condizioni.length === 4);
  ok('la riga dice QUALI mancano', /Mancano: build/.test(valutaCondizioni({ ...buone, build: { verde: false } }).riga));

  return (async () => {
    const chiamati = [];
    let r = await riavviaInSequenza({
      riavvia: async (n) => { chiamati.push(n); },
      stato: async (n) => ({ online: true, pid: 1, uptimeMs: 20_000, restarts: chiamati.includes(n) ? 2 : 1 }),
      attende: async () => {}, commit: 'abc123',
    });
    ok('la cascata riavvia tutti e tre in ordine', r.ok === true && chiamati.join(',') === ORDINE.join(','));
    ok('  e l\'ordine va dal piu\' lontano dal capitale al piu\' vicino', ORDINE[0] === 'agent24-liquidity-rewards' && ORDINE[2] === 'agent40-manual-reprice');

    const c2 = [];
    r = await riavviaInSequenza({
      riavvia: async (n) => { c2.push(n); },
      stato: async (n) => (n === 'agent41-realloc-scheduler' ? { online: false } : { online: true, pid: 1, uptimeMs: 20_000, restarts: 1 }),
      attende: async () => {},
    });
    ok('se uno non torna su, ci si FERMA e gli altri non si toccano',
      r.ok === false && c2.length === 2 && !c2.includes('agent40-manual-reprice'));

    const c3 = [];
    // Prima del riavvio 1, dopo 5: quattro riavvii nella finestra ⇒ sta rimbalzando, non e' «tornato su».
    r = await riavviaInSequenza({
      riavvia: async (n) => { c3.push(n); },
      stato: async () => ({ online: true, pid: 1, uptimeMs: 20_000, restarts: c3.length ? 5 : 1 }),
      attende: async () => {},
    });
    ok('un processo che RIMBALZA conta come non tornato su', r.ok === false && c3.length === 1);

    r = await riavviaInSequenza({});
    ok('senza esecutore iniettato non si riavvia niente', r.ok === false && /non riavvia niente da solo/.test(r.motivo));

    const righe = [];
    await riavviaInSequenza({
      agenti: ['agent24-liquidity-rewards'], riavvia: async () => {},
      stato: async () => ({ online: true, pid: 7, uptimeMs: 20_000, restarts: 1 }),
      attende: async () => {}, audit: (x) => righe.push(x), commit: 'deadbeef',
    });
    ok('ogni riavvio finisce nel giornale con ora, agent e commit',
      righe.length === 1 && righe[0].requested.agent === 'agent24-liquidity-rewards' && righe[0].requested.commit === 'deadbeef');

    console.log(`riavvio-condizionato selfcheck: ${p} passati, ${f} falliti`);
    return f === 0;
  })();
}

module.exports = { valutaCondizioni, riavviaInSequenza, selfcheck, BASELINE_ROSSI, ORDINE };

if (require.main === module) selfcheck().then((v) => process.exit(v ? 0 : 1));

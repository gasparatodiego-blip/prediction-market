'use strict';

/**
 * DUE PRESIDI NUOVI, DUE PROPRIETÀ DA DIFENDERE — 13 agosto 2026.
 *
 *   ① il guardiano non scatta più sulla PRIMA lettura oltre soglia (k = 2, e le due letture devono
 *      essere anche contigue nel tempo);
 *   ② la sentinella sul collasso vede un calo dell'85% dal massimo mobile, e NON grida quando il calo
 *      l'ha prodotto il guardiano.
 *
 * Si difendono le PROPRIETÀ, non i numeri: `k` e la soglia si leggono dalle costanti del modulo, così
 * una ritaratura futura sui dati nuovi non produce un rosso finto.
 */

const { decidiScatto, confermaScatto, LETTURE_CONSECUTIVE_PER_SCATTO,
  ETA_MASSIMA_FRA_LETTURE_MS } = require('./guardian-perdite');
const { valutaCollasso, SOGLIA_CALO_PCT, FINESTRA_MASSIMO_MS,
  GRAZIA_GUARDIANO_MS } = require('./sentinella-collasso');

let passati = 0; let falliti = 0;
const ok = (nome, cond, extra = '') => {
  if (cond) { passati++; console.log(`  ✓ ${nome}`); }
  else { falliti++; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};

const SOGLIE = { sogliaPct: 5, sogliaAbs: 30 };
const pnlDi = (usd, base = 660.56) => ({ calcolabile: true, pnlUsd: usd,
  pnlPct: +((usd / base) * 100).toFixed(6), motivo: null });

/**
 * Rigioca una sequenza di letture `[{dtSec, usd, letturaAt}]` e restituisce gli istanti di scatto.
 *
 * `letturaAt` è l'istante in cui la voce di cache del saldo è stata scritta. Se non lo si passa, il
 * default simula una cache che si rinfresca a ogni giro — cioè letture sempre DISTINTE, che è il caso
 * che i test scritti prima del 13 agosto davano per scontato.
 */
function rigioca(letture, k = LETTURE_CONSECUTIVE_PER_SCATTO) {
  let stato = null; let t = 1_000_000_000;
  const scatti = []; const preallarmi = [];
  for (const l of letture) {
    t += (l.dtSec != null ? l.dtSec : 30) * 1000;
    const pnl = pnlDi(l.usd);
    const dec = decidiScatto({ pnl, ...SOGLIE });
    const osservazione = { saldoLetturaAt: l.letturaAt !== undefined ? l.letturaAt : t };
    const c = confermaScatto({ stato, decisione: dec, pnl, now: t, k, osservazione });
    stato = c.stato;
    if (c.scatta) { scatti.push({ t, usd: l.usd, conferme: c.conferme }); stato = null; }
    else if (c.preAllarme) preallarmi.push({ t, usd: l.usd, fermo: c.inAttesaDiDatoFresco === true });
  }
  return { scatti, preallarmi };
}

// ══ ① LA PERSISTENZA DEL GUARDIANO ═════════════════════════════════════════════════════════════
console.log('\n── il guardiano non scatta sulla prima lettura');
{
  ok('una sola lettura oltre soglia NON fa scattare',
    rigioca([{ usd: -36.15 }]).scatti.length === 0);
  ok('  ma produce un pre-allarme, cioè non passa muta',
    rigioca([{ usd: -36.15 }]).preallarmi.length === 1);
  ok('due letture consecutive oltre soglia FANNO scattare',
    rigioca([{ usd: -36.15 }, { usd: -37.02 }]).scatti.length === 1);
  ok('  e lo scatto dichiara quante conferme ha avuto',
    rigioca([{ usd: -36.15 }, { usd: -37.02 }]).scatti[0].conferme === LETTURE_CONSECUTIVE_PER_SCATTO);
}

console.log('\n── il rientro azzera il contatore');
{
  // Il caso vero: oltre soglia, rientra, poi di nuovo oltre. Non deve scattare: non sono consecutive.
  const r = rigioca([{ usd: -36.15 }, { usd: -1.37 }, { usd: -36.90 }]);
  ok('oltre soglia → rientro → oltre soglia NON fa scattare', r.scatti.length === 0);
  ok('  e i pre-allarmi sono due, uno per ogni superamento', r.preallarmi.length === 2);
  const c = confermaScatto({ stato: { conferme: 1, primaAt: 1000, ultimaAt: 1000, valoreUsd: -36 },
    decisione: { scatta: false }, pnl: pnlDi(-1), now: 31_000 });
  ok('il rientro dichiara PERCHE\' ha azzerato', c.azzeratoPer === 'rientro' && c.conferme === 0);
}

console.log('\n── consecutive vuol dire anche CONTIGUE nel tempo (il buco > 120 s)');
{
  const dentro = (ETA_MASSIMA_FRA_LETTURE_MS / 1000) - 1;
  const fuori = (ETA_MASSIMA_FRA_LETTURE_MS / 1000) + 1;
  ok(`due letture a ${dentro}s di distanza sono contigue ⇒ scatta`,
    rigioca([{ usd: -36.15 }, { usd: -37.02, dtSec: dentro }]).scatti.length === 1);
  ok(`due letture a ${fuori}s di distanza NON sono contigue ⇒ non scatta`,
    rigioca([{ usd: -36.15 }, { usd: -37.02, dtSec: fuori }]).scatti.length === 0);
  const c = confermaScatto({ stato: { conferme: 1, primaAt: 0, ultimaAt: 0, valoreUsd: -36 },
    decisione: { scatta: true }, pnl: pnlDi(-37), now: ETA_MASSIMA_FRA_LETTURE_MS + 5000 });
  ok('  e il buco temporale si DICHIARA', c.azzeratoPer === 'buco-temporale' && c.conferme === 1);
  // Tre letture con un buco in mezzo: il contatore riparte, quindi servono altre due dopo il buco.
  const r = rigioca([{ usd: -36 }, { usd: -36, dtSec: fuori }, { usd: -36 }]);
  ok('dopo un buco servono di nuovo due letture', r.scatti.length === 1 && r.scatti[0].conferme === 2);
}

// ══ IL CASO DEL 13 AGOSTO 11:24 — DUE LETTURE UGUALI NON SONO DUE OSSERVAZIONI ═════════════════
console.log('\n── due letture dalla STESSA voce di cache non confermano');
{
  const CACHE = 900_000_000;   // l'istante in cui la voce di cache è stata scritta
  // Il caso reale: due giri a 30 s che leggono la stessa voce (TTL 45 s > cadenza 30 s).
  const copia = rigioca([
    { usd: -32.58335, letturaAt: CACHE },
    { usd: -32.58335, letturaAt: CACHE },
  ]);
  ok('due letture con lo STESSO timestamp di saldo NON fanno scattare', copia.scatti.length === 0,
    JSON.stringify(copia.scatti));
  ok('  e la seconda è dichiarata FERMA in attesa di un dato fresco',
    copia.preallarmi.length === 2 && copia.preallarmi[1].fermo === true);

  // Con un terzo giro che finalmente legge una voce NUOVA, la conferma arriva.
  const poiFresco = rigioca([
    { usd: -32.58335, letturaAt: CACHE },
    { usd: -32.58335, letturaAt: CACHE },
    { usd: -32.58335, letturaAt: CACHE + 45_000 },
  ]);
  ok('appena la cache si rinfresca, la conferma vale e si scatta', poiFresco.scatti.length === 1);
  ok('  con esattamente due conferme, non tre', poiFresco.scatti[0].conferme === 2);

  // Il contatore NON si azzera mentre aspetta: resta a 1 e riparte da lì.
  const c1 = confermaScatto({ stato: null, decisione: { scatta: true }, pnl: pnlDi(-32),
    now: 1000, osservazione: { saldoLetturaAt: CACHE } });
  const c2 = confermaScatto({ stato: c1.stato, decisione: { scatta: true }, pnl: pnlDi(-32),
    now: 31_000, osservazione: { saldoLetturaAt: CACHE } });
  ok('il contatore resta a 1 mentre aspetta, non si azzera', c2.conferme === 1 && c2.azzeratoPer === null);
  ok('  e lo stato conserva il timestamp della lettura che HA contato',
    c2.stato.saldoLetturaAt === CACHE);

  // FALLISCE CHIUSO: se l'istante non è leggibile, non si conferma.
  for (const v of [null, undefined, NaN, 'boh']) {
    const a = confermaScatto({ stato: null, decisione: { scatta: true }, pnl: pnlDi(-32), now: 1000,
      osservazione: { saldoLetturaAt: v } });
    const b = confermaScatto({ stato: a.stato, decisione: { scatta: true }, pnl: pnlDi(-32), now: 31_000,
      osservazione: { saldoLetturaAt: v } });
    ok(`istante «${String(v)}» non leggibile ⇒ non conferma`, b.scatta === false && b.inAttesaDiDatoFresco === true);
  }
  const senza = confermaScatto({ stato: null, decisione: { scatta: true }, pnl: pnlDi(-32), now: 1000 });
  const senza2 = confermaScatto({ stato: senza.stato, decisione: { scatta: true }, pnl: pnlDi(-32), now: 31_000 });
  ok('dep `osservazione` non iniettata ⇒ non si scatta (fail closed)', senza2.scatta === false);

  // Il rientro azzera comunque, anche mentre si aspetta un dato fresco.
  const r = confermaScatto({ stato: c2.stato, decisione: { scatta: false }, pnl: pnlDi(-1), now: 61_000 });
  ok('un rientro azzera anche durante l\'attesa', r.conferme === 0 && r.azzeratoPer === 'rientro');
}

console.log('\n── una lettura NON CALCOLABILE non fa da ponte');
{
  const nc = { calcolabile: false, pnlUsd: null, pnlPct: null, motivo: 'saldo non leggibile' };
  const dec = decidiScatto({ pnl: nc, ...SOGLIE });
  ok('decidiScatto su un PnL non calcolabile non scatta', dec.scatta === false);
  const c = confermaScatto({ stato: { conferme: 1, primaAt: 0, ultimaAt: 0, valoreUsd: -36 },
    decisione: dec, pnl: nc, now: 30_000 });
  ok('e azzera il contatore: «non ho letto» non conferma che la perdita persisteva', c.conferme === 0);
}

console.log('\n── la sequenza VERA del 13 agosto non produce più uno scatto');
{
  // Dal log di agent43, letture a 30 s. Nessuna coppia consecutiva è oltre soglia.
  const vera = [
    { usd: -1.66 }, { usd: -26.46 }, { usd: -1.37 }, { usd: -1.89 },
    { usd: 8.06 }, { usd: -4.70 }, { usd: -36.146124 },
  ];
  const r1 = rigioca(vera, 1);
  const r2 = rigioca(vera, LETTURE_CONSECUTIVE_PER_SCATTO);
  ok('con k=1 (il comportamento vecchio) scatta', r1.scatti.length === 1);
  ok('con k=2 NON scatta', r2.scatti.length === 0, JSON.stringify(r2.scatti));
  ok('  e l\'evento resta comunque visibile come pre-allarme', r2.preallarmi.length >= 1);
}

console.log('\n── una perdita VERA e persistente scatta comunque, solo 30 s più tardi');
{
  const persistente = [{ usd: -31 }, { usd: -33 }, { usd: -35 }];
  const r = rigioca(persistente);
  ok('tre letture oltre soglia fanno scattare', r.scatti.length === 1);
  ok('  al SECONDO campione, non al terzo: il ritardo è di un solo giro',
    r.scatti[0].t === 1_000_000_000 + 60_000);
}

// ══ ② LA SENTINELLA SUL COLLASSO ═══════════════════════════════════════════════════════════════
const T = 2_000_000_000;
const storicoA = (n, quanti = 5, fine = T) => Array.from({ length: quanti },
  (_, i) => ({ ts: fine - (quanti - i) * 60_000, n }));
const BASE = { botAvviato: true, killAttivo: false, guardianScattatoAt: null };

console.log('\n── la soglia dell\'85% separa il fisiologico dal patologico');
{
  // I due estremi MISURATI: fisiologico massimo 75% (30→8), patologico minimo 92,9% (28→2).
  ok('30 → 8 (75%, il fisiologico più grande) NON è anomalia',
    valutaCollasso({ ...BASE, storico: storicoA(30), ordiniARiposo: 8, now: T }).anomalia === false);
  ok('28 → 2 (92,9%, il patologico più piccolo) È anomalia',
    valutaCollasso({ ...BASE, storico: storicoA(28), ordiniARiposo: 2, now: T }).anomalia === true);
  ok('la soglia cade nel VUOTO fra le due popolazioni',
    SOGLIA_CALO_PCT > 75 && SOGLIA_CALO_PCT < 92.9);
  // Il calo si misura sul massimo, non sul campione precedente: un crollo in due passi si vede lo stesso.
  const p1 = valutaCollasso({ ...BASE, storico: storicoA(28, 5, T - 120_000), ordiniARiposo: 15, now: T - 60_000 });
  const p2 = valutaCollasso({ ...BASE, storico: p1.storico, ordiniARiposo: 2, now: T });
  ok('un crollo 28 → 15 → 2 non si lascia spezzare in due passi sotto soglia',
    p1.anomalia === false && p2.anomalia === true);
  ok('  e il calo dichiarato è quello dal MASSIMO, non dal campione precedente', p2.massimo === 28);
}

console.log('\n── il presidio non si auto-inganna: lo scatto del guardiano SPIEGA il calo');
{
  const g = valutaCollasso({ ...BASE, storico: storicoA(23), ordiniARiposo: 2, now: T,
    guardianScattatoAt: T - 5 * 60_000 });
  ok('calo prodotto dal guardiano ⇒ NON è anomalia', g.anomalia === false);
  ok('  ma è SOSPESO, non ignorato: il calo resta misurato e dichiarato',
    g.sospeso === true && g.caloPct > SOGLIA_CALO_PCT);
  const oltre = valutaCollasso({ ...BASE, storico: storicoA(23), ordiniARiposo: 2, now: T,
    guardianScattatoAt: T - GRAZIA_GUARDIANO_MS - 60_000 });
  ok('oltre la grazia lo scatto non spiega più niente ⇒ torna anomalia', oltre.anomalia === true);
  ok('un latch non leggibile (null) non impedisce di vedere il collasso vero',
    valutaCollasso({ ...BASE, storico: storicoA(23), ordiniARiposo: 2, now: T,
      guardianScattatoAt: null }).anomalia === true);
}

console.log('\n── il presidio SOLO OSSERVA: non esiste nessun campo che agisca');
{
  const r = valutaCollasso({ ...BASE, storico: storicoA(23), ordiniARiposo: 2, now: T });
  const vietati = ['ferma', 'cancella', 'stop', 'kill', 'disattiva', 'azione', 'deveFermare', 'deveCancellare'];
  const trovati = vietati.filter((k) => Object.prototype.hasOwnProperty.call(r, k));
  ok('il verdetto non porta nessun campo che possa fermare o cancellare',
    trovati.length === 0, trovati.join(','));
  ok('  e nemmeno una richiesta di ricostruzione: questo presidio non chiede azioni',
    !Object.prototype.hasOwnProperty.call(r, 'deveRicostruire'));
}

console.log('\n── ciò che non si legge non grida, e il bot fermo non è un\'anomalia');
{
  for (const v of [null, undefined, NaN, -1, 'venti', {}]) {
    ok(`conteggio «${JSON.stringify(v)}» non arma`,
      valutaCollasso({ ...BASE, storico: storicoA(23), ordiniARiposo: v, now: T }).anomalia === false);
  }
  ok('bot su FERMA non arma',
    valutaCollasso({ storico: storicoA(23), ordiniARiposo: 0, now: T, botAvviato: false, killAttivo: false }).anomalia === false);
  ok('KILL attivo non arma',
    valutaCollasso({ storico: storicoA(23), ordiniARiposo: 0, now: T, botAvviato: true, killAttivo: true }).anomalia === false);
  ok('la finestra del massimo è quella dichiarata: un picco più vecchio non conta',
    valutaCollasso({ ...BASE, storico: [{ ts: T - FINESTRA_MASSIMO_MS - 60_000, n: 30 }], ordiniARiposo: 2, now: T }).anomalia === false);
}

console.log(`\npersistenza e collasso: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

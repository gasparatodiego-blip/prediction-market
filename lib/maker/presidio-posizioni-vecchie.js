'use strict';
// lib/maker/presidio-posizioni-vecchie.js — NESSUNA POSIZIONE RESTA APERTA OLTRE UN'ORA. PURO.
//
// ═══ PERCHÉ ESISTE, E PERCHÉ NON È ELEGANTE ══════════════════════════════════════════════════════════
// 16 agosto 2026: un fill su FL-27 alle 15:19 è rimasto aperto **cinque ore**. Le regole per chiuderlo
// esistevano tutte — Livello 1 taker, Livello 2 maker a 30 min, uscita peggiorativa a 60 — e nessuna è
// scattata, perché l'orologio della scala si azzera a ogni ripiazzamento del completamento: la scala
// credeva di essere al minuto 1 mentre erano passati 68. Il difetto è §5-bis p.138, e la sua correzione
// è rimandata alla prossima sessione perché riscrivere la scala d'uscita di slancio è come si producono
// le regressioni che oggi sono costate quelle cinque ore.
//
// Questo modulo NON è quella correzione. È un **presidio indipendente**, deliberatamente stupido:
// non conosce gradini, non conosce la modalità di chiusura, non legge lo stato del maker. Guarda una
// cosa sola — da quanto tempo esiste questa posizione — e oltre la soglia dice «chiudila».
//
// ⚠ È UN LIMITE SUPERIORE AL DANNO, NON UNA STRATEGIA. La scala d'uscita, quando funzionerà, chiuderà
// prima e meglio: a 30 minuti col taker, a 60 con una concessione di un tick. Questo presidio scatta
// DOPO, e accetta il prezzo che trova. Serve solo a garantire che il caso peggiore sia un'ora e non
// cinque. Quando la scala sarà riscritta e provata fino allo scatto di ogni gradino, questo modulo
// diventerà ridondante — e allora si toglie, non prima.
//
// ═══ L'ANCORA È SUA, E NON DIPENDE DA NIENTE ═════════════════════════════════════════════════════════
// La scala si è azzerata perché contava da uno stato che il bot riscrive. Questo presidio non fa quello
// sbaglio: tiene un **registro proprio**, `asset → primo istante in cui l'ho vista`. Non lo ricalcola
// da nessuno stato di chiusura, non lo condivide con la scala, e nessun percorso del maker lo tocca.
// Una posizione che sparisce perde la sua ancora; una che ricompare ne prende una nuova, ed è giusto:
// è un'altra posizione.
//
// ⚠ AL PRIMO GIRO LE POSIZIONI GIÀ APERTE PARTONO DA ADESSO. Non c'è modo di sapere quando sono nate
// senza fidarsi di uno stato del maker, che è ciò da cui questo modulo esiste per essere indipendente.
// Conseguenza dichiarata: dopo un riavvio il presidio concede una soglia intera prima di agire. È
// prudente nella direzione giusta — ritarda una chiusura, non ne anticipa una sbagliata.
//
// ═══ COSA NON CHIUDE, E PERCHÉ ═══════════════════════════════════════════════════════════════════════
//   · una posizione che fa parte di una **coppia completa** — YES e NO in parti uguali sullo stesso
//     mercato — non è esposizione direzionale: vale $1/share alla risoluzione qualunque cosa accada, e
//     liquidarla significherebbe attraversare due spread per recuperare niente;
//   · una posizione **sotto il minimo del venue**, che nessun ordine valido può chiudere (§5.2 p.1):
//     dirle di chiudersi produrrebbe solo rifiuti a ogni giro.

const SOGLIA_MS = 60 * 60_000;

const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => { const n = Number(x); return fin(n) ? n : null; };

/**
 * @param a.posizioni   [{ asset, conditionId, size, avgPrice, curPrice }] dal VENUE
 * @param a.ancore      { [asset]: primoIstanteMs } — il registro del presidio, suo e di nessun altro
 * @param a.minSizePerMercato { [conditionId]: minSize } — il minimo del venue, per non chiedere
 *                      l'impossibile. Assente ⇒ non si giudica quel vincolo e si procede.
 * @param a.ora
 * @param a.sogliaMs
 * @returns {{daChiudere:Array, tenute:Array, ancore:object}}
 */
function valuta(a = {}) {
  const ora = fin(a.ora) ? a.ora : Date.now();
  const soglia = fin(a.sogliaMs) && a.sogliaMs > 0 ? a.sogliaMs : SOGLIA_MS;
  const pos = Array.isArray(a.posizioni) ? a.posizioni : null;
  // ⚠ POSIZIONI NON LEGGIBILI ⇒ NON SI FA NIENTE, e le ancore NON si toccano. Azzerarle qui
  // significherebbe che ogni singhiozzo della lettura regala un'altra ora a una posizione vecchia.
  if (!pos) return { daChiudere: [], tenute: [], ancore: { ...(a.ancore || {}) }, motivo: 'posizioni non leggibili: nessuna decisione, ancore invariate' };

  const vecchie = (a.ancore && typeof a.ancore === 'object') ? a.ancore : {};
  const ancore = {};
  const perMercato = new Map();
  for (const p of pos) {
    const asset = norm(p && (p.asset || p.tokenId));
    const size = num(p && p.size);
    if (!asset || size === null || size <= 0) continue;
    const cid = norm(p && p.conditionId);
    if (!perMercato.has(cid)) perMercato.set(cid, []);
    perMercato.get(cid).push({ asset, size, p });
    ancore[asset] = fin(vecchie[asset]) ? vecchie[asset] : ora;
  }

  const daChiudere = []; const tenute = [];
  for (const [cid, lista] of perMercato) {
    // ── LA COPPIA COMPLETA NON SI TOCCA ───────────────────────────────────────────────────────────
    // Due token diversi dello stesso mercato con la STESSA size sono una coppia: esposizione
    // direzionale zero. Si confronta con tolleranza perché i fill parziali lasciano decimali.
    const coppia = lista.length === 2
      && Math.abs(lista[0].size - lista[1].size) <= Math.max(0.01, lista[0].size * 0.001);
    for (const x of lista) {
      const eta = ora - ancore[x.asset];
      const minSize = a.minSizePerMercato && fin(num(a.minSizePerMercato[cid])) ? num(a.minSizePerMercato[cid]) : null;
      const sottoMinimo = minSize !== null && x.size < minSize;
      const voce = { asset: x.asset, conditionId: cid, size: x.size,
        avgPrice: num(x.p.avgPrice), curPrice: num(x.p.curPrice), etaMin: +(eta / 60000).toFixed(1) };
      if (coppia) { tenute.push({ ...voce, motivo: 'coppia completa: esposizione direzionale zero, vale $1/share alla risoluzione' }); continue; }
      if (sottoMinimo) { tenute.push({ ...voce, motivo: `sotto il minimo del venue (${x.size} < ${minSize}): nessun ordine valido puo' chiuderla (§5.2 p.1)` }); continue; }
      if (eta < soglia) { tenute.push({ ...voce, motivo: `aperta da ${voce.etaMin} min, sotto la soglia di ${Math.round(soglia / 60000)} min` }); continue; }
      daChiudere.push({ ...voce,
        motivo: `posizione DIREZIONALE aperta da ${voce.etaMin} min, oltre la soglia di ${Math.round(soglia / 60000)} min:`
          + ' la scala d\'uscita non l\'ha chiusa e il presidio non aspetta oltre' });
    }
  }
  return { daChiudere, tenute, ancore, motivo: null };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ presidio posizioni vecchie ════');
  const T = 1_000_000_000;
  const P = (asset, cid, size, extra = {}) => ({ asset, conditionId: cid, size, avgPrice: 0.2, curPrice: 0.17, ...extra });

  // ── L'ANCORA NASCE E NON SI MUOVE ───────────────────────────────────────────────────────────────
  const r1 = valuta({ posizioni: [P('a', 'm1', 56.82)], ancore: {}, ora: T });
  ok('al primo avvistamento l\'ancora e\' adesso e non si chiude niente',
    r1.ancore.a === T && r1.daChiudere.length === 0);
  const r2 = valuta({ posizioni: [P('a', 'm1', 56.82)], ancore: r1.ancore, ora: T + 59 * 60_000 });
  ok('  a 59 minuti si tiene', r2.daChiudere.length === 0 && r2.ancore.a === T);
  const r3 = valuta({ posizioni: [P('a', 'm1', 56.82)], ancore: r2.ancore, ora: T + 61 * 60_000 });
  ok('  a 61 minuti si CHIUDE — il caso FL-27, che oggi e\' durato cinque ore',
    r3.daChiudere.length === 1 && r3.daChiudere[0].etaMin === 61);
  ok('  e l\'ancora NON si e\' mossa nel frattempo', r3.ancore.a === T);

  // ── LA COPPIA COMPLETA NON SI TOCCA ─────────────────────────────────────────────────────────────
  const cp = valuta({ posizioni: [P('y', 'm2', 57.1), P('n', 'm2', 57.1)],
    ancore: { y: T, n: T }, ora: T + 300 * 60_000 });
  ok('una coppia completa non si chiude nemmeno dopo cinque ore', cp.daChiudere.length === 0);
  ok('  e il motivo dice perche\'', /coppia completa/.test(cp.tenute[0].motivo));
  const scomp = valuta({ posizioni: [P('y', 'm2', 57.1), P('n', 'm2', 30)],
    ancore: { y: T, n: T }, ora: T + 61 * 60_000 });
  ok('  ma due gambe di size DIVERSA non sono una coppia: si chiudono entrambe', scomp.daChiudere.length === 2);

  // ── SOTTO IL MINIMO DEL VENUE ───────────────────────────────────────────────────────────────────
  const min = valuta({ posizioni: [P('h', 'm3', 6)], ancore: { h: T }, ora: T + 300 * 60_000,
    minSizePerMercato: { m3: 20 } });
  ok('una posizione sotto il minimo del venue non si chiede di chiudere (Hong Kong)',
    min.daChiudere.length === 0 && /sotto il minimo/.test(min.tenute[0].motivo));
  const min2 = valuta({ posizioni: [P('h', 'm3', 60)], ancore: { h: T }, ora: T + 61 * 60_000,
    minSizePerMercato: { m3: 20 } });
  ok('  ma sopra il minimo si chiude normalmente', min2.daChiudere.length === 1);

  // ── FAIL-SAFE ───────────────────────────────────────────────────────────────────────────────────
  const ill = valuta({ posizioni: null, ancore: { a: T }, ora: T + 300 * 60_000 });
  ok('posizioni non leggibili: nessuna decisione E ancore invariate',
    ill.daChiudere.length === 0 && ill.ancore.a === T);
  const sparita = valuta({ posizioni: [], ancore: { a: T }, ora: T + 61 * 60_000 });
  ok('una posizione sparita perde la sua ancora', sparita.ancore.a === undefined);
  const tornata = valuta({ posizioni: [P('a', 'm1', 56.82)], ancore: sparita.ancore, ora: T + 62 * 60_000 });
  ok('  e se ricompare riparte da zero: e\' un\'altra posizione',
    tornata.daChiudere.length === 0 && tornata.ancore.a === T + 62 * 60_000);
  ok('size illeggibile o zero: ignorata, non chiusa',
    valuta({ posizioni: [P('a', 'm1', 0), P('b', 'm1', null)], ancore: {}, ora: T }).daChiudere.length === 0);

  // ── LA SOGLIA ───────────────────────────────────────────────────────────────────────────────────
  ok('la soglia e\' 60 minuti, come il gradino d\'uscita della scala', SOGLIA_MS === 60 * 60_000);

  console.log(`\npresidio-posizioni-vecchie: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { valuta, SOGLIA_MS, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

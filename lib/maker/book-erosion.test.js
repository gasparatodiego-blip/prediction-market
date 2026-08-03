#!/usr/bin/env node
'use strict';
// IL SECONDO TRIGGER: l'erosione della coda fra l'ordine e il mid.
//
// Questo file esaurisce la MISURA e la MACCHINA A STATI. Il cablaggio nel ciclo — l'OR col trigger
// esistente, il freno fra due riprezzi, i mercati direzionali — vive in book-erosion-cycle.test.js,
// perche' quelle sono domande sul motore e non sull'aritmetica.
//
// Aritmetica pura: nessun venue, nessun file, nessun orologio vero.

const {
  zoneDepth, emptyErosionState, updateErosion, erosionConfig, erosionEligible, repriceAllowed, triggerKind,
  EROSION_TRIGGER_PCT, EROSION_RECOVERY_PCT, BASELINE_WINDOW_MS, EROSION_CONFIRM_READINGS,
  BASELINE_MIN_SAMPLES, BASELINE_MIN_SPAN_MS, EROSION_MIN_MARKET_MINUTES, REPRICE_MIN_INTERVAL_MS,
} = require('./book-erosion');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const S = 1000;
const M = 60 * S;

// Una serie di letture, con lo stesso passo del ciclo vero (3s).
function feed(state, valori, { cfg, t0 = 1_000_000_000, stepMs = 3 * S } = {}) {
  let ultimo = null;
  valori.forEach((d, i) => { ultimo = updateErosion(state, { depth: d, now: t0 + i * stepMs, cfg }); });
  return ultimo;
}
/** Abbastanza letture stabili da completare il riscaldamento (campioni E span). */
function riscalda(state, livello, cfg, t0 = 1_000_000_000) {
  const n = Math.ceil(BASELINE_MIN_SPAN_MS / (3 * S)) + BASELINE_MIN_SAMPLES + 2;
  return { last: feed(state, Array(n).fill(livello), { cfg, t0 }), nextT: t0 + n * 3 * S };
}

console.log('\n── le costanti stanno in un punto solo, e sono quelle chieste');
{
  ok('soglia di erosione 40%', EROSION_TRIGGER_PCT === 40);
  ok('rientro 60% — la fascia 40-60 e zona morta', EROSION_RECOVERY_PCT === 60 && EROSION_RECOVERY_PCT > EROSION_TRIGGER_PCT);
  ok('finestra della baseline dentro i 5-10 min chiesti', BASELINE_WINDOW_MS >= 5 * M && BASELINE_WINDOW_MS <= 10 * M, `${BASELINE_WINDOW_MS / M} min`);
  ok('conferma ad almeno 2 letture', EROSION_CONFIRM_READINGS >= 2);
  ok('esiste un freno fra due riprezzi', REPRICE_MIN_INTERVAL_MS > 0, `${REPRICE_MIN_INTERVAL_MS / S}s`);
  const c = erosionConfig();
  ok('erosionConfig() senza argomenti restituisce i default', c.triggerPct === 40 && c.recoveryPct === 60 && c.minIntervalMs === REPRICE_MIN_INTERVAL_MS);
  const t = erosionConfig({ erosionTriggerPct: 25, minIntervalMs: 45_000 });
  ok('  e si puo tarare da fuori, in un punto solo', t.triggerPct === 25 && t.minIntervalMs === 45_000);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ LA MISURA · quanta size c e fra il mio ordine e il mid');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  // Ordine a 0.46, mid 0.50. Davanti a me: 0.47, 0.48, 0.49.
  const levels = [
    { price: 0.49, size: 100 }, { price: 0.48, size: 200 }, { price: 0.47, size: 50 },
    { price: 0.46, size: 999 },  // il MIO livello
    { price: 0.45, size: 400 },  // dietro di me
  ];
  const z = zoneDepth({ levels, orderPrice: 0.46, sideMid: 0.50 });
  ok('somma solo i livelli fra l ordine e il mid', z.depth === 350, `${z.depth} share su 3 livelli`);
  ok('  il MIO livello non si conta', z.depth !== 350 + 999, 'misurerebbe me, non il mercato');
  ok('  ne quelli dietro di me', z.depth !== 350 + 400);
  ok('  e dichiara quanti livelli ha visto', z.levels === 3);
}

console.log('\n── i livelli oltre il mid non stanno «fra me e il mid»');
{
  // Book sottile: il filtro anti-polvere del programma premi puo' portare il mid di scoring SOTTO il
  // miglior bid. In quel caso la zona e vuota, e non si allarga a coprire book che non c entra.
  const levels = [{ price: 0.60, size: 500 }, { price: 0.55, size: 300 }];
  const z = zoneDepth({ levels, orderPrice: 0.46, sideMid: 0.50 });
  ok('mid di scoring sotto il miglior bid ⇒ zona vuota', z.readable === true && z.depth === 0, `${z.depth}`);
}

console.log('\n── una zona vuota e zero; un book NON LETTO non e zero');
{
  ok('nessun livello pubblicato ⇒ non leggibile', zoneDepth({ levels: null, orderPrice: 0.46, sideMid: 0.5 }).readable === false);
  ok('lista vuota ⇒ non leggibile', zoneDepth({ levels: [], orderPrice: 0.46, sideMid: 0.5 }).readable === false);
  ok('  e non depth 0', zoneDepth({ levels: [], orderPrice: 0.46, sideMid: 0.5 }).depth === null);
  ok('nessun ordine a riposo ⇒ non leggibile', zoneDepth({ levels: [{ price: 0.49, size: 1 }], orderPrice: null, sideMid: 0.5 }).readable === false);
  ok('mid non leggibile ⇒ non leggibile', zoneDepth({ levels: [{ price: 0.49, size: 1 }], orderPrice: 0.46, sideMid: null }).readable === false);
  const vuota = zoneDepth({ levels: [{ price: 0.45, size: 10 }], orderPrice: 0.46, sideMid: 0.5 });
  ok('book presente ma nessuno davanti a me ⇒ profondita ZERO, leggibile', vuota.readable === true && vuota.depth === 0);
}

console.log('\n── i livelli arrivano come stringhe dal venue, e si contano lo stesso');
{
  const z = zoneDepth({ levels: [{ price: '0.49', size: '120.5' }, { price: '0.48', size: '0' }], orderPrice: 0.46, sideMid: 0.50 });
  ok('stringhe convertite', z.depth === 120.5, String(z.depth));
  ok('  size 0 = livello cancellato, non esiste', z.levels === 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ LA BASELINE ADATTIVA · lo stesso metro non vale per due book diversi');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const cfg = erosionConfig();
  // Due mercati con liquidita' di ordini di grandezza diversi, LO STESSO calo relativo.
  const sottile = emptyErosionState();
  riscalda(sottile, 150, cfg);
  const spesso = emptyErosionState();
  riscalda(spesso, 11_000, cfg);

  const t = 1_000_000_000 + 200 * S;
  const a1 = updateErosion(sottile, { depth: 45, now: t, cfg });          // 30% di 150
  const a2 = updateErosion(sottile, { depth: 45, now: t + 3 * S, cfg });
  const b1 = updateErosion(spesso, { depth: 3_300, now: t, cfg });        // 30% di 11.000
  const b2 = updateErosion(spesso, { depth: 3_300, now: t + 3 * S, cfg });

  ok('book da 150 share: baseline ~150', Math.abs(a1.baseline - 150) < 1, String(a1.baseline));
  ok('book da 11.000 share: baseline ~11.000', Math.abs(b1.baseline - 11_000) < 1, String(b1.baseline));
  ok('stesso calo relativo ⇒ STESSO verdetto sui due', a2.erosion === true && b2.erosion === true,
    'una soglia fissa in share ne avrebbe visto uno solo');
  ok('  e lo stesso rapporto', a2.ratioPct === b2.ratioPct, `${a2.ratioPct}% su entrambi`);

  // La controprova: 3.300 share sul book SOTTILE sarebbero abbondanza, non erosione.
  const controprova = emptyErosionState();
  riscalda(controprova, 150, cfg);
  const c = updateErosion(controprova, { depth: 3_300, now: t, cfg });
  ok('3.300 share su un book da 150 NON sono erosione', c.erosion === false, `${c.ratioPct}%`);
}

console.log('\n── senza riscaldamento non si afferma niente');
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  // Prima lettura in assoluto: bassa quanto si vuole, non c e un metro per giudicarla.
  const primo = updateErosion(st, { depth: 1, now: 1_000_000_000, cfg });
  ok('la primissima lettura non arma nulla', primo.erosion === false && primo.established === false);
  ok('  e lo dice invece di tacere', /riscaldamento|nulla che possa erodersi/.test(primo.reason), primo.reason.slice(0, 60));

  // Abbastanza CAMPIONI ma in troppo poco tempo: 6 letture in 3 secondi non descrivono la normalita'.
  const st2 = emptyErosionState();
  feed(st2, [100, 100, 100, 100, 100, 100], { cfg, stepMs: 500 });
  const v = updateErosion(st2, { depth: 10, now: 1_000_000_000 + 3 * S, cfg });
  ok('campioni sufficienti ma span troppo corto ⇒ ancora riscaldamento', v.established === false, v.reason.slice(0, 70));

  // Abbastanza TEMPO ma pochissimi campioni.
  const st3 = emptyErosionState();
  feed(st3, [100, 100], { cfg, stepMs: 90 * S });
  const v3 = updateErosion(st3, { depth: 10, now: 1_000_000_000 + 200 * S, cfg });
  ok('span sufficiente ma campioni troppo pochi ⇒ ancora riscaldamento', v3.established === false);
}

console.log('\n── una baseline a zero non e divisibile: l ordine sul tocco non arma mai');
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  riscalda(st, 0, cfg);   // ordine piazzato SUL tocco: davanti non c e mai nessuno
  const v = updateErosion(st, { depth: 0, now: 1_000_000_000 + 300 * S, cfg });
  ok('profondita sempre zero ⇒ nessun trigger, mai', v.erosion === false && v.established === false);
  ok('  e il motivo lo spiega', /non c e nulla che possa erodersi/.test(v.reason), v.reason.slice(0, 60));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ LA CONFERMA A DUE LETTURE · il rumore non muove ordini');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  const { nextT } = riscalda(st, 1000, cfg);

  const uno = updateErosion(st, { depth: 200, now: nextT, cfg });   // 20% — sotto soglia
  ok('UNA lettura sotto soglia non arma', uno.erosion === false, `${uno.ratioPct}%, streak ${uno.belowStreak}`);
  ok('  ma la conta', uno.belowStreak === 1);
  ok('  e lo dice', /ne servono 2 consecutive/.test(uno.reason), uno.reason.slice(0, 70));

  const due = updateErosion(st, { depth: 200, now: nextT + 3 * S, cfg });
  ok('la SECONDA consecutiva arma', due.erosion === true && due.fired === true, `${due.ratioPct}%`);
}

console.log('\n── una singola oscillazione in mezzo AZZERA la conferma');
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  const { nextT } = riscalda(st, 1000, cfg);

  updateErosion(st, { depth: 200, now: nextT, cfg });                       // sotto  (streak 1)
  const risalita = updateErosion(st, { depth: 900, now: nextT + 3 * S, cfg }); // sopra → azzera
  ok('una lettura normale in mezzo azzera lo streak', risalita.belowStreak === 0, `${risalita.ratioPct}%`);
  const dopo = updateErosion(st, { depth: 200, now: nextT + 6 * S, cfg });
  ok('  quindi la successiva bassa riparte da 1, non arma', dopo.erosion === false && dopo.belowStreak === 1);
}

console.log('\n── una lettura NON LEGGIBILE non e una lettura bassa');
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  const { nextT } = riscalda(st, 1000, cfg);

  updateErosion(st, { depth: 200, now: nextT, cfg });                     // streak 1
  const buco = updateErosion(st, { depth: null, now: nextT + 3 * S, cfg }); // feed sparito
  ok('profondita non leggibile ⇒ nessun verdetto', buco.readable === false);
  ok('  lo streak NON avanza', buco.belowStreak === 1, `resta ${buco.belowStreak}`);
  ok('  e nemmeno si azzera: lo stato resta com era', buco.erosion === false);
  const poi = updateErosion(st, { depth: 200, now: nextT + 6 * S, cfg });
  ok('  la lettura vera successiva completa la conferma', poi.erosion === true && poi.fired === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ L ISTERESI 40/60 · non si rimbalza sullo stesso confine');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  const { nextT } = riscalda(st, 1000, cfg);
  let t = nextT;
  updateErosion(st, { depth: 200, now: t, cfg });
  const armato = updateErosion(st, { depth: 200, now: (t += 3 * S), cfg });
  ok('armato al 20%', armato.erosion === true);

  // Risalita DENTRO la zona morta: sopra il 40 ma sotto il 60.
  const morta1 = updateErosion(st, { depth: 450, now: (t += 3 * S), cfg });
  ok('45% — sopra la soglia di innesco ma dentro la zona morta ⇒ resta armato', morta1.erosion === true, `${morta1.ratioPct}%`);
  const morta2 = updateErosion(st, { depth: 570, now: (t += 3 * S), cfg });
  ok('58% — ancora zona morta ⇒ ancora armato', morta2.erosion === true, `${morta2.ratioPct}%`);

  const rientro = updateErosion(st, { depth: 650, now: (t += 3 * S), cfg });
  ok('66% — sopra il rientro ⇒ si disarma', rientro.erosion === false && rientro.recovered === true, `${rientro.ratioPct}%`);
  ok('  e si torna a inseguire il solo mid', /si torna a inseguire il solo mid/.test(rientro.reason));

  // E ora il punto: appena disarmati, una lettura al 45% NON riarma (serve di nuovo <40 + conferma).
  const dopo = updateErosion(st, { depth: 450, now: (t += 3 * S), cfg });
  ok('subito dopo il rientro, il 45% non riarma', dopo.erosion === false, 'senza la zona morta qui si oscillerebbe');
}

console.log('\n── l isteresi si misura sulla baseline CONGELATA, non su una che scende con il book');
{
  const cfg = erosionConfig();
  const st = emptyErosionState();
  const { nextT } = riscalda(st, 1000, cfg);
  let t = nextT;
  updateErosion(st, { depth: 200, now: t, cfg });
  const armato = updateErosion(st, { depth: 200, now: (t += 3 * S), cfg });
  const congelata = armato.baseline;

  // Il book resta sottile a lungo: la baseline VIVA scende verso 200. Se l isteresi la usasse, 200
  // diventerebbe il 100% di se stessa e il «recupero» arriverebbe senza che il book recuperi nulla.
  for (let i = 0; i < 120; i += 1) updateErosion(st, { depth: 200, now: (t += 3 * S), cfg });
  const dopo = updateErosion(st, { depth: 200, now: (t += 3 * S), cfg });
  ok('dopo 6 minuti di book sottile si e ANCORA armati', dopo.erosion === true, `${dopo.ratioPct}% della baseline congelata`);
  ok('  perche il metro e rimasto quello dell innesco', Math.abs(dopo.baseline - congelata) < 1e-6, `${dopo.baseline} vs ${congelata}`);
  ok('  e 200 share non sono magicamente diventate normali', dopo.ratioPct < EROSION_RECOVERY_PCT);
}

console.log('\n── la finestra scorre davvero: cio che e vecchio esce dalla media');
{
  const cfg = erosionConfig({ erosionWindowMs: 60 * S });
  const st = emptyErosionState();
  feed(st, Array(30).fill(1000), { cfg, stepMs: 3 * S });     // 90s di storia, ma finestra 60s
  const v = updateErosion(st, { depth: 1000, now: 1_000_000_000 + 90 * S, cfg });
  ok('i campioni oltre la finestra sono stati potati', v.samples <= Math.ceil(60 * S / (3 * S)) + 1, `${v.samples} campioni`);
  ok('  e la baseline resta quella del periodo dentro finestra', Math.abs(v.baseline - 1000) < 1e-6);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ CHI E CANDIDATO · la banda e la vita residua');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const cfg = erosionConfig();
  const buono = erosionEligible({ closeKnown: true, minutesToClose: 5000, bandRadiusCents: 2.25, cfg });
  ok('mercato reward con banda e vita lunga ⇒ candidato', buono.eligible === true);

  const senzaBanda = erosionEligible({ closeKnown: true, minutesToClose: 5000, bandRadiusCents: null, cfg });
  ok('senza banda pubblicata ⇒ NON candidato', senzaBanda.eligible === false && senzaBanda.gate === 'no-band');

  const ignota = erosionEligible({ closeKnown: false, minutesToClose: null, bandRadiusCents: 2.25, cfg });
  ok('chiusura non leggibile ⇒ NON candidato (fail closed)', ignota.eligible === false && ignota.gate === 'close-unknown',
    'l assenza di un fatto non ne prende il posto');
}

console.log('\n── I MERCATI DIREZIONALI VELOCI RESTANO FUORI, e per una ragione di misura');
{
  const cfg = erosionConfig();
  // «Bitcoin Up or Down» a 5 minuti — con banda pubblicata, quindi la banda da sola non basta a escluderlo.
  const btc5 = erosionEligible({ closeKnown: true, minutesToClose: 5, bandRadiusCents: 2.25, cfg });
  ok('ciclo BTC da 5 minuti ⇒ NON candidato', btc5.eligible === false && btc5.gate === 'market-too-short');
  ok('  e il motivo e la validita della misura, non una lista di nomi',
    /finestra della baseline .* sarebbe piu lunga/.test(btc5.reason), btc5.reason.slice(0, 90));

  const eth15 = erosionEligible({ closeKnown: true, minutesToClose: 15, bandRadiusCents: 2.25, cfg });
  ok('ciclo ETH da 15 minuti ⇒ NON candidato', eth15.eligible === false && eth15.gate === 'market-too-short');

  ok('la soglia e piu lunga della finestra della baseline', EROSION_MIN_MARKET_MINUTES * M >= BASELINE_WINDOW_MS,
    `${EROSION_MIN_MARKET_MINUTES} min contro ${BASELINE_WINDOW_MS / M} min di finestra`);

  // Anche un mercato LUNGO, arrivato in fondo, esce: e la stessa regola, e va bene cosi.
  const lungoInFondo = erosionEligible({ closeKnown: true, minutesToClose: 12, bandRadiusCents: 2.25, cfg });
  ok('un mercato lungo nei suoi ultimi minuti esce con la stessa regola', lungoInFondo.eligible === false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ IL FRENO FRA DUE RIPREZZI');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const cfg = erosionConfig();
  const now = 1_000_000_000;
  ok('mai riprezzato ⇒ passa', repriceAllowed({ trigger: 'out-of-band', lastRepriceAt: null, now, cfg }).allowed === true);
  ok('riprezzato 5s fa ⇒ frenato', repriceAllowed({ trigger: 'out-of-band', lastRepriceAt: now - 5 * S, now, cfg }).allowed === false);
  ok('riprezzato 31s fa ⇒ passa', repriceAllowed({ trigger: 'out-of-band', lastRepriceAt: now - 31 * S, now, cfg }).allowed === true);
  ok('  vale identico per l erosione', repriceAllowed({ trigger: 'erosion', lastRepriceAt: now - 5 * S, now, cfg }).allowed === false,
    'il freno non guarda quale segnale ha chiesto il movimento');
  const frenato = repriceAllowed({ trigger: 'erosion', lastRepriceAt: now - 5 * S, now, cfg });
  ok('  e spiega quanto manca', /attendo altri 25s/.test(frenato.reason), frenato.reason.slice(0, 80));
}

console.log('\n── DUE ESENZIONI, e sono quelle che non possono essere frenate');
{
  const cfg = erosionConfig();
  const now = 1_000_000_000;
  ok('il PRIMO piazzamento non e un riprezzo', repriceAllowed({ trigger: 'missing', lastRepriceAt: now - 1 * S, now, cfg }).allowed === true);
  ok('  ne lo e «initial»', repriceAllowed({ trigger: 'initial', lastRepriceAt: now - 1 * S, now, cfg }).allowed === true);
  ok('il RINNOVO GTD non si frena MAI', repriceAllowed({ trigger: 'expiry-renewal', lastRepriceAt: now - 1 * S, now, cfg }).allowed === true,
    'frenarlo farebbe scadere l ordine davvero: sarebbe un guasto, non un freno');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ DOVE SI VA · l arretramento al bordo premiante (punto 7)');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const { erosionRetreat } = require('./book-erosion');
  const r = erosionRetreat({ offsetCents: 1, bandRadiusCents: 2.25, tick: 0.001 });
  ok('da 1¢, banda 2.25¢, tick 0.1¢ ⇒ ci si ritira a 2.2¢', r.ok === true && r.offsetCents === 2.2, String(r.offsetCents));
  ok('  che e DENTRO il raggio, non oltre', r.offsetCents <= 2.25);
  ok('  arrotondato verso l INTERNO', r.offsetCents !== 2.3, 'un tick per eccesso finirebbe fuori banda');

  const bordo = erosionRetreat({ offsetCents: 2.2, bandRadiusCents: 2.25, tick: 0.001 });
  ok('gia al bordo ⇒ non si agisce', bordo.ok === false);
  ok('  e non si inventa un prezzo fuori banda', bordo.offsetCents === null);
  ok('  dicendo perche', /gia al bordo premiante/.test(bordo.reason), bordo.reason.slice(0, 60));

  // Il caso che conta in produzione: tick grosso e banda stretta lasciano UN SOLO passo.
  const grosso = erosionRetreat({ offsetCents: 1, bandRadiusCents: 2.25, tick: 0.01 });
  ok('tick 1¢ e raggio 2.25¢ ⇒ un solo passo possibile, a 2¢', grosso.ok === true && grosso.offsetCents === 2, String(grosso.offsetCents));
  const grossoAlBordo = erosionRetreat({ offsetCents: 2, bandRadiusCents: 2.25, tick: 0.01 });
  ok('  e da 2¢ non si va piu da nessuna parte', grossoAlBordo.ok === false,
    'su tick 1¢ il meccanismo ha un solo scalino: e una conseguenza della griglia del venue, non una scelta');

  const stretta = erosionRetreat({ offsetCents: 0.5, bandRadiusCents: 0.4, tick: 0.01 });
  ok('raggio piu stretto di un tick ⇒ nessun arretramento esprimibile', stretta.ok === false, stretta.reason.slice(0, 60));

  for (const [et, a] of [
    ['offset assente', { offsetCents: null, bandRadiusCents: 2.25, tick: 0.01 }],
    ['banda assente', { offsetCents: 1, bandRadiusCents: null, tick: 0.01 }],
    ['tick assente', { offsetCents: 1, bandRadiusCents: 2.25, tick: null }],
    ['nessun argomento', undefined],
  ]) {
    const v = a === undefined ? erosionRetreat() : erosionRetreat(a);
    ok(`  ${et} ⇒ nessun arretramento`, v.ok === false && v.offsetCents === null);
  }
}

console.log('\n── l etichetta che finisce nell audit');
{
  ok('solo mid', triggerKind({ mid: true, erosion: false }) === 'mid');
  ok('solo erosione', triggerKind({ mid: false, erosion: true }) === 'erosione');
  ok('entrambi', triggerKind({ mid: true, erosion: true }) === 'entrambi');
  ok('nessuno ⇒ null, non una stringa inventata', triggerKind({ mid: false, erosion: false }) === null);
}

console.log(`\nerosione del book: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

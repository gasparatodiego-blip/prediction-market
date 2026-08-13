#!/usr/bin/env node
'use strict';
// L'USCITA DOPO UN FILL: dove si piazza, e quando si smette di aspettarla.
//
// Revisione del 3 agosto 2026 — il pavimento fisso al 4% e' stato SOSTITUITO da un trigger legato alla
// banda reward, piu' un tetto di attesa. Le due decisioni sono separate e testate separatamente:
//   planExit()   → a che prezzo si piazza (una volta, al fill)
//   decideExit() → se va ancora aspettata (a ogni ciclo, con la banda riletta)
//
// Aritmetica pura: nessun venue, nessun ordine, nessun file.

const { planExit, decideExit, exitNeedsMove, bandBounds, EXIT_PROFIT_PCT, MAX_WAIT_HOURS, MAX_WAIT_MS } = require('./exit-plan');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const H = 3_600_000;

console.log('\n── le costanti, in un punto solo');
{
  ok('obiettivo 1%', EXIT_PROFIT_PCT === 1);
  ok('tetto di attesa 24 ore', MAX_WAIT_HOURS === 24 && MAX_WAIT_MS === 24 * H);
  ok('IL PAVIMENTO FISSO NON ESISTE PIU', typeof require('./exit-plan').MAX_ADVERSE_PCT === 'undefined',
    'sostituito dal trigger a banda: due logiche in parallelo sarebbero due risposte alla stessa domanda');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ planExit · DOVE si piazza');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: 5 });
  ok('carico 50¢ ⇒ uscita a 51¢ (+1%, arrotondato in su)', p.ok && p.price === 0.51, String(p.price));
  ok('  deciso dall obiettivo', p.clampedBy === 'obiettivo');

  const f = planExit({ entryPrice: 0.500, scoringMid: 0.500, tick: 0.001, bandRadiusCents: 5 });
  ok('con tick fine ⇒ esattamente +1%', f.price === 0.505 && f.profitPct === 1, `${f.price} · ${f.profitPct}%`);
}

console.log('\n── la percentuale vale uguale a ogni prezzo (il vecchio +1¢ no)');
{
  const basso = planExit({ entryPrice: 0.10, scoringMid: 0.10, tick: 0.001, bandRadiusCents: 5 });
  const alto = planExit({ entryPrice: 0.90, scoringMid: 0.90, tick: 0.001, bandRadiusCents: 5 });
  ok('a 10¢ ⇒ 10.1¢', basso.price === 0.101, String(basso.price));
  ok('a 90¢ ⇒ 90.9¢', alto.price === 0.909, String(alto.price));
  ok('  stessa percentuale a due prezzi lontanissimi', basso.profitPct === alto.profitPct);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ IL MERCATO GIA ANDATO A FAVORE · +1% dal MASSIMO fra carico e mercato');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── LO SCENARIO OSSERVATO IN PRODUZIONE il 3 agosto 2026');
{
  // Dai log di agent40, riprodotto alla lettera:
  //   fill YES a 16.75¢ · mercato salito a 99.9¢ · uscita proposta 17¢ (= +1% dal carico)
  // Erano ~$166 su 200 share che l'ordine avrebbe regalato. Non e' successo nulla solo perche' la
  // guardia della banda ha rifiutato quel prezzo per essere troppo lontano dal mid — cioe' per il
  // motivo sbagliato.
  const p = planExit({ entryPrice: 0.1675, scoringMid: 0.999, tick: 0.001, bandRadiusCents: 2.25 });
  ok('l uscita si piazza', p.ok === true, p.reason);
  ok('  NON e piu 17¢ (+1% dal carico)', p.price !== 0.17, `era 0.17, ora ${p.price}`);
  ok('  ma vicino al prezzo corrente di 99.9¢', p.price >= 0.99, String(p.price));
  ok('  cioe al massimo prezzo esprimibile dal venue', p.price === 0.999 && p.clampedBy === 'limite-del-libro', p.clampedBy);
  ok('  la base dell obiettivo e il MERCATO, non il carico', p.basePrice === 0.999 && p.marketAhead === true);
  ok('  e l obiettivo dal solo carico resta dichiarato, per confronto', p.targetFromEntry === 0.17, String(p.targetFromEntry));
  ok('  il guadagno non e piu 1% ma quasi 500%', p.profitPct > 400, `${p.profitPct}%`);
  ok('  e il motivo lo spiega', /supera il massimo prezzo esprimibile/.test(p.reason), p.reason.slice(0, 70));
}

console.log('\n── un movimento a favore PIU MODESTO segue comunque il mercato');
{
  // Carico 50¢, mercato salito a 60¢. Obiettivo dal carico: 50.5¢ — ma il mercato ne vale gia 60.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.60, tick: 0.001, bandRadiusCents: 2.25 });
  ok('la base diventa il mercato', p.basePrice === 0.60 && p.marketAhead === true);
  ok('  uscita a 60.6¢, non a 50.5¢', p.price === 0.606, String(p.price));
  ok('  clampedBy «mercato-a-favore»', p.clampedBy === 'mercato-a-favore', p.clampedBy);
  ok('  e resta DENTRO la banda corrente', p.price <= p.bandHi + 1e-12, `${p.price} vs bordo ${p.bandHi}`);
  ok('  +21% invece di +1%', p.profitPct > 20, `${p.profitPct}%`);
}

console.log('\n── la banda resta il tetto anche quando il mercato e a favore');
{
  // Mercato a 60¢ ma banda strettissima: l obiettivo 60.6¢ cade oltre il bordo 60.2¢.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.60, tick: 0.001, bandRadiusCents: 0.2 });
  ok('si esce al bordo premiante, non oltre', p.price === p.bandHi, `${p.price} vs ${p.bandHi}`);
  ok('  dichiarato «banda»', p.clampedBy === 'banda');
  ok('  e comunque MOLTO sopra il vecchio +1% dal carico', p.price > 0.505, `${p.price} contro 0.505`);
}

console.log('\n── SENZA movimento a favore NON cambia assolutamente nulla');
{
  // La soglia e l obiettivo originale: finche il mercato non lo supera, il comportamento e quello di prima.
  const sotto = planExit({ entryPrice: 0.50, scoringMid: 0.503, tick: 0.001, bandRadiusCents: 5 });
  ok('mercato a 50.3¢, obiettivo dal carico 50.5¢ ⇒ base ancora il CARICO', sotto.basePrice === 0.50 && sotto.marketAhead === false);
  ok('  uscita all obiettivo di sempre', sotto.price === 0.505, String(sotto.price));
  ok('  clampedBy «obiettivo»', sotto.clampedBy === 'obiettivo');

  // Esattamente SUL confine: il mercato pareggia l obiettivo, non lo supera ⇒ invariato.
  const pari = planExit({ entryPrice: 0.50, scoringMid: 0.505, tick: 0.001, bandRadiusCents: 5 });
  ok('mercato esattamente all obiettivo ⇒ ancora invariato', pari.marketAhead === false && pari.price === 0.505);

  // E un mercato SCESO non abbassa mai l obiettivo.
  const giu = planExit({ entryPrice: 0.50, scoringMid: 0.48, tick: 0.001, bandRadiusCents: 5 });
  ok('mercato SCESO ⇒ l obiettivo non si abbassa', giu.price === 0.505 && giu.marketAhead === false, String(giu.price));
}

console.log('\n── un mid non leggibile non e un mercato fermo');
{
  const p = planExit({ entryPrice: 0.50, scoringMid: null, tick: 0.001, bandRadiusCents: null });
  ok('senza mid si resta sull obiettivo dal carico', p.ok && p.price === 0.505 && p.marketAhead === false,
    'l assenza di un fatto non ne prende il posto');
}

console.log('\n── IL CRICCHETTO: con exitNeedsMove l uscita sale e non torna giu');
{
  const t = 0.001;
  const p1 = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: t, bandRadiusCents: 5 });
  const p2 = planExit({ entryPrice: 0.50, scoringMid: 0.60, tick: t, bandRadiusCents: 5 });
  const p3 = planExit({ entryPrice: 0.50, scoringMid: 0.55, tick: t, bandRadiusCents: 5 });
  ok('mercato a 50 ⇒ uscita 50.5¢', p1.price === 0.505);
  ok('mercato sale a 60 ⇒ il piano sale a 60.6¢', p2.price === 0.606);
  ok('  e l uscita a riposo viene ALZATA', exitNeedsMove({ restingPrice: p1.price, plan: p2, tick: t }).move === true);
  ok('mercato ridiscende a 55 ⇒ il piano scende a 55.6¢', p3.price === 0.556);
  ok('  ma l uscita a riposo NON viene abbassata', exitNeedsMove({ restingPrice: p2.price, plan: p3, tick: t }).move === false,
    'a quel punto decide decideExit, che chiude a mercato invece di svendere un tick alla volta');
}

console.log('\n── il tetto del libro e configurabile ma ha un default sensato');
{
  const d = planExit({ entryPrice: 0.90, scoringMid: 0.995, tick: 0.01, bandRadiusCents: 5 });
  ok('tick 0.01 ⇒ tetto 0.99', d.priceMax === 0.99 && d.price === 0.99, `${d.price}`);
  const e = planExit({ entryPrice: 0.90, scoringMid: 0.995, tick: 0.01, bandRadiusCents: 5, priceMax: 0.95 });
  ok('un tetto esplicito vince', e.price === 0.95, String(e.price));
}

console.log('\n── la banda limita l obiettivo VERSO L ALTO, perche il trigger abbia senso');
{
  // Banda stretta: l obiettivo cadrebbe oltre il bordo, e un ordine piazzato gia fuori banda farebbe
  // scattare il trigger al primo ciclo — chiudendo a mercato senza nemmeno provare a uscire in utile.
  // carico 50¢ ⇒ obiettivo 50.5¢. Con mid 50.2¢ e raggio 0.2¢ il bordo alto e 50.4¢: l obiettivo lo supera.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.502, tick: 0.001, bandRadiusCents: 0.2 });
  ok('l uscita non supera il bordo premiante', p.ok && p.price <= p.bandHi + 1e-12, `${p.price} vs bordo ${p.bandHi}`);
  ok('  ed e dichiarato', p.clampedBy === 'banda', p.clampedBy);
  ok('  e resta comunque sopra il carico', p.price > 0.50, String(p.price));
}

console.log('\n── NESSUN PAVIMENTO: l uscita non viene mai spinta sotto l obiettivo');
{
  // Mercato crollato. Con la vecchia logica qui usciva un ordine a carico −4%; ora NON si piazza in
  // perdita: se ne occupa decideExit chiudendo a mercato.
  const p = planExit({ entryPrice: 0.50, scoringMid: 0.30, tick: 0.01, bandRadiusCents: 2.25 });
  ok('banda scesa sotto il carico ⇒ nessuna uscita piazzata', p.ok === false);
  // Il motivo nomina il PAVIMENTO, che senza concessione E' il carico. Si asserisce la proprieta'
  // — «dice sotto cosa e' scesa la banda» — e non la frase, che la scala di urgenza ha riscritto.
  ok('  e il motivo lo spiega', /sotto il pavimento di uscita/.test(p.reason)
    && /0\.5/.test(p.reason), p.reason.slice(0, 90));
  ok('  senza inventare un prezzo in perdita', p.price === null);
  ok('  ma dichiarando dov e la banda', p.bandHi != null && p.bandHi < 0.50);
}

console.log('\n── cio che non si legge non produce un prezzo');
{
  for (const [et, args] of [
    ['carico assente', { entryPrice: null, tick: 0.01 }],
    ['tick assente', { entryPrice: 0.5, tick: null }],
    ['nessun argomento', undefined],
  ]) {
    const p = args === undefined ? planExit() : planExit(args);
    ok(`  ${et} ⇒ nessuna uscita`, p.ok === false && p.price === null);
  }
  const senzaBanda = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: null });
  ok('senza banda pubblicata si esce comunque all obiettivo', senzaBanda.ok && senzaBanda.price === 0.51);
  ok('  e bandHi resta null, non un numero inventato', senzaBanda.bandHi === null);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ decideExit · SE va ancora aspettata (trigger a banda + tetto di tempo)');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const base = { tick: 0.01, scoringMid: 0.50, bandRadiusCents: 2.25, now: 1_000_000_000 };

console.log('\n── dentro banda e nei tempi: si aspetta');
{
  const d = decideExit({ ...base, exitPrice: 0.51, restingSinceMs: base.now - 2 * H });
  ok('azione hold', d.action === 'hold', d.action);
  ok('  nessun trigger', d.trigger === null);
  ok('  e dice da quanto aspetta', /a riposo da 2\.0h/.test(d.reason), d.reason.slice(0, 70));
}

console.log('\n── TRIGGER 1 · il MID si e mosso e l uscita e finita fuori banda');
{
  // uscita a 51¢, mid sceso a 45¢ ⇒ banda 42.75–47.25: l uscita e sopra il bordo
  const d = decideExit({ ...base, scoringMid: 0.45, exitPrice: 0.51, restingSinceMs: base.now - 1 * H });
  ok('chiusura a mercato', d.action === 'close-at-market', d.action);
  ok('  trigger «band-exit»', d.trigger === 'band-exit');
  ok('  con i bordi nel motivo', /0\.4[0-9]*–0\.4[0-9]*/.test(d.reason), d.reason.slice(0, 90));
}

console.log('\n── TRIGGER 1-bis · LA BANDA SI E RISTRETTA, il mid NON si e mosso');
{
  // E il caso che una soglia percentuale sul carico NON puo vedere: 4 casi su 48 nel backtest.
  const largo = decideExit({ ...base, exitPrice: 0.515, bandRadiusCents: 2.25, restingSinceMs: base.now - H });
  ok('con banda ±2.25¢ l uscita a 51.5¢ e dentro', largo.action === 'hold', largo.action);
  const stretto = decideExit({ ...base, exitPrice: 0.515, bandRadiusCents: 0.5, restingSinceMs: base.now - H });
  ok('  ristretta a ±0.5¢, la STESSA uscita e fuori', stretto.action === 'close-at-market', stretto.action);
  ok('  col mid identico e il prezzo identico', stretto.trigger === 'band-exit',
    'nessuna soglia percentuale sul carico potrebbe vedere questo caso');
}

console.log('\n── TRIGGER 2 · il tetto di attesa, anche se DENTRO banda');
{
  const quasi = decideExit({ ...base, exitPrice: 0.51, restingSinceMs: base.now - 23.9 * H });
  ok('a 23.9h si aspetta ancora', quasi.action === 'hold', quasi.action);
  const scaduto = decideExit({ ...base, exitPrice: 0.51, restingSinceMs: base.now - 24.1 * H });
  ok('a 24.1h si chiude a mercato', scaduto.action === 'close-at-market', scaduto.action);
  ok('  trigger «max-wait»', scaduto.trigger === 'max-wait');
  ok('  ANCHE se l uscita era dentro banda', /ancora dentro banda/.test(scaduto.reason), scaduto.reason.slice(-60));
  ok('  e il tetto e configurabile', decideExit({ ...base, exitPrice: 0.51, restingSinceMs: base.now - 2 * H, maxWaitMs: 1 * H }).trigger === 'max-wait');
}

console.log('\n── la banda VINCE sul tempo quando scattano insieme');
{
  const d = decideExit({ ...base, scoringMid: 0.45, exitPrice: 0.51, restingSinceMs: base.now - 30 * H });
  ok('fuori banda E oltre il tempo ⇒ si riporta «band-exit»', d.trigger === 'band-exit',
    'e la causa piu informativa: dice PERCHE non maturava piu');
}

console.log('\n── una banda non leggibile NON e «sei fuori»');
{
  const d = decideExit({ ...base, bandRadiusCents: null, exitPrice: 0.51, restingSinceMs: base.now - 2 * H });
  ok('senza banda si continua ad aspettare', d.action === 'hold', d.action);
  ok('  e lo dice', /non si afferma/.test(d.reason), d.reason.slice(0, 70));
  const t = decideExit({ ...base, bandRadiusCents: null, exitPrice: 0.51, restingSinceMs: base.now - 30 * H });
  ok('  ma il tetto di tempo vale lo stesso', t.action === 'close-at-market' && t.trigger === 'max-wait');
}

console.log('\n── senza un uscita a riposo non c e nulla da giudicare');
{
  ok('exitPrice assente ⇒ hold', decideExit({ ...base, exitPrice: null }).action === 'hold');
  ok('nessun argomento ⇒ hold', decideExit().action === 'hold');
}

console.log('\n── bandBounds: i bordi si arrotondano VERSO L INTERNO');
{
  const b = bandBounds({ scoringMid: 0.50, bandRadiusCents: 2.25, tick: 0.01 });
  ok('bordo basso arrotondato in su', b.lo === 0.48, String(b.lo));
  ok('bordo alto arrotondato in giu', b.hi === 0.52, String(b.hi));
  ok('  cosi un prezzo sul bordo e davvero dentro', b.readable === true);
  ok('senza mid o senza raggio ⇒ non leggibile', bandBounds({ scoringMid: null, bandRadiusCents: 2, tick: 0.01 }).readable === false);
}

console.log('\n── NON si abbassa mai un uscita gia a riposo');
{
  const piano = planExit({ entryPrice: 0.50, scoringMid: 0.50, tick: 0.01, bandRadiusCents: 10 });
  ok('senza uscita a riposo: la si piazza', exitNeedsMove({ restingPrice: null, plan: piano, tick: 0.01 }).move === true);
  ok('gia al prezzo giusto: non si tocca', exitNeedsMove({ restingPrice: 0.51, plan: piano, tick: 0.01 }).move === false);
  ok('piu bassa del piano: si alza', exitNeedsMove({ restingPrice: 0.505, plan: piano, tick: 0.001 }).move === true);
  const giu = exitNeedsMove({ restingPrice: 0.55, plan: piano, tick: 0.01 });
  ok('piu alta del piano: NON si abbassa', giu.move === false, giu.reason.slice(0, 60));
}

console.log(`\npiano di uscita: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

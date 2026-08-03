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
  ok('  e il motivo lo spiega', /gia\' sotto il prezzo di carico/.test(p.reason), p.reason.slice(0, 80));
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

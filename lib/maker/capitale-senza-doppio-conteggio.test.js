'use strict';
// lib/maker/capitale-senza-doppio-conteggio.test.js — UN ORDINE A RIPOSO NON È DENARO IN PIÙ.
//
// ═══ IL BUG, E PERCHÉ NON ERA ESTETICO ══════════════════════════════════════════════════════════════
// `misuraUtilizzo` sommava tre fonti come indipendenti — `saldo + ordiniARiposo + posizioni` — ma non lo
// sono e non lo sono mai:
//   · un BUY a riposo è coperto dal CASH. Su Polymarket l'ordine è firmato off-chain e il collaterale
//     resta nel wallet fino al match: il saldo NON scende quando si mette l'ordine.
//   · un SELL a riposo è coperto dai TOKEN, cioè dalla posizione: già dentro `posizioniUsd`.
// `ordiniARiposoUsd` è quindi un SOTTOINSIEME di `saldo + posizioni`, mai un addendo.
//
// MISURATO il 9 agosto 2026 con lettura on-chain del funder:
//   cash $633,90 + posizioni $35,19 = $669,09   ← esattamente il Portfolio dell'app Polymarket
//   il sistema dichiarava            $776,65    ← +$107,46, cioè +16,1%
//
// DUE CONSEGUENZE OPERATIVE, non di visualizzazione:
//   1. `liberoUsd` riportava il saldo PIENO come impegnabile, mentre $107,46 erano già promessi a
//      ordini sul libro. Il trigger a capitale fermo decide su quel numero quanto piazzare.
//   2. il tetto di concentrazione è il 20% del totale: gonfiare il totale ALLARGA un limite di rischio.
//      Il 9 agosto valeva $155,33 invece di $133,82.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · i numeri veri del 9 agosto tornano a coincidere con l'app
//   2 · il libero è il cash MENO gli ordini a riposo, e il trigger usa quello
//   3 · il tetto di concentrazione torna al 20% del capitale vero
//   4 · nessuna somma può superare il totale, e i rifiuti fail-closed restano

const fs = require('fs');
const path = require('path');
const U = require('./utilizzo-capitale');
const { capPerMarketUsd, MARKET_CAP_FIXED_USD } = require('../rewards/concentration');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// I NUMERI VERI dell'incidente, letti on-chain e dallo snapshot delle posizioni.
const CASH = 633.90;
const RIPOSO = 107.46;
const POSIZIONI = 35.19;
const TOTALE_VERO = 669.09;      // il Portfolio dell'app Polymarket
const LIBERO_VERO = 526.44;      // cash − ordini a riposo

console.log('── 1 · IL TOTALE TORNA A COINCIDERE CON L\'APP');
{
  const u = U.misuraUtilizzo({ saldoUsd: CASH, ordiniARiposoUsd: RIPOSO, posizioniUsd: POSIZIONI });
  ok('la misura è leggibile', u.leggibile === true, u.motivo);
  ok('il totale è cash + posizioni', u.capitaleTotaleUsd === TOTALE_VERO, `$${u.capitaleTotaleUsd} (atteso $${TOTALE_VERO})`);
  ok('  e NON somma gli ordini a riposo come fonte indipendente',
    u.capitaleTotaleUsd !== +(CASH + RIPOSO + POSIZIONI).toFixed(4), `il vecchio numero era $${(CASH + RIPOSO + POSIZIONI).toFixed(2)}`);
  ok('  lo scarto col vecchio calcolo è esattamente il nozionale a riposo',
    +((CASH + RIPOSO + POSIZIONI) - u.capitaleTotaleUsd).toFixed(2) === RIPOSO, `$${RIPOSO}`);

  // Il saldo grezzo resta leggibile accanto al libero: sono due domande diverse.
  ok('il saldo grezzo resta esposto', u.saldoUsd === CASH, `$${u.saldoUsd}`);
  ok('  e anche il nozionale a riposo', u.ordiniARiposoUsd === RIPOSO);
}

console.log('\n── 2 · IL LIBERO È IL CASH MENO GLI ORDINI A RIPOSO');
{
  const u = U.misuraUtilizzo({ saldoUsd: CASH, ordiniARiposoUsd: RIPOSO, posizioniUsd: POSIZIONI });
  ok('il libero non è più il saldo pieno', u.liberoUsd !== CASH, `$${u.liberoUsd} invece di $${CASH}`);
  ok('  ed è cash − ordini a riposo', u.liberoUsd === LIBERO_VERO, `$${u.liberoUsd} (atteso $${LIBERO_VERO})`);
  ok('l\'impegnato è il resto del totale', u.impegnatoUsd === +(TOTALE_VERO - LIBERO_VERO).toFixed(4), `$${u.impegnatoUsd}`);
  ok('  cioè posizioni + cash che copre i BUY a riposo',
    u.impegnatoUsd === +(POSIZIONI + RIPOSO).toFixed(4), `$${u.impegnatoUsd} = ${POSIZIONI} + ${RIPOSO}`);
  // L'utilizzo VERO è più alto di quello che si leggeva: il denominatore era gonfiato più del numeratore.
  ok('l\'utilizzo vero è più alto di quello dichiarato prima', u.pct > 18.4, `${u.pct}% (prima si leggeva 18.4%)`);

  // Il trigger deve usare QUESTO numero, non il saldo grezzo.
  const ag = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  ok('il trigger punta a impegnare al più il LIBERO, non il saldo',
    /Math\.min\(utilPrima\.liberoUsd, utilPrima\.deficitUsd\)/.test(ag));
  ok('  e passa il libero a pianificaGiro come disponibile',
    /disponibileUsd: spendibileUsd/.test(ag) && /const spendibileUsd = utilPrima\.leggibile \? utilPrima\.liberoUsd/.test(ag));
  // ⚠ Questa asserzione contava i punti («=== 3»), cioè fotografava il codice invece di difenderne la
  // proprietà: il 13 agosto 2026 la ricostruzione del piano ne ha aggiunto un quarto e il test è
  // diventato rosso senza che niente si fosse rotto. Adesso difende la cosa vera — OGNI `disponibileUsd`
  // passato a `pianificaGiro` è il libero, e nessuno è il saldo grezzo — che è più forte di un conteggio
  // e non invecchia quando nasce un quinto punto.
  const tuttiIDisponibili = ag.match(/disponibileUsd: [A-Za-z0-9_.]+/g) || [];
  ok('  in TUTTI i punti in cui pianifica, non solo nel primo',
    tuttiIDisponibili.length >= 3
    && tuttiIDisponibili.every((x) => /spendibileUsd/.test(x))
    && !/disponibileUsd: decisione\.saldoUsd/.test(ag), `punti: ${tuttiIDisponibili.join(' | ')}`);
  ok('  e il ripiego per capitale totale non somma più gli ordini',
    !/utilPrima\.capitaleTotaleUsd : decisione\.saldoUsd \+ aRiposo/.test(ag));

  // Il commento che ha originato l'assunzione sbagliata è stato corretto, non cancellato.
  const t = fs.readFileSync(path.join(__dirname, 'trigger-capitale-fermo.js'), 'utf8');
  ok('il commento falso è stato corretto e marcato', /QUI C'ERA UN'AFFERMAZIONE FALSA/.test(t));
  ok('  e dice il fatto giusto sul venue', /il collaterale resta nel wallet fino al match/.test(t));
}

console.log('\n── 3 · IL TETTO PER MERCATO È IMMUNE AL TOTALE GONFIATO');
{
  const u = U.misuraUtilizzo({ saldoUsd: CASH, ordiniARiposoUsd: RIPOSO, posizioniUsd: POSIZIONI });
  const cap = capPerMarketUsd(u.capitaleTotaleUsd);
  const totale = u.capitaleTotaleUsd;
  // ── QUESTA SEZIONE È STATA RISCRITTA IL 9 AGOSTO 2026, E IL SUO PUNTO NON CAMBIA ────────────────
  // Il difetto che questo file difende è il DOPPIO CONTEGGIO del capitale (§5 punto 58): il totale
  // gonfiato a $776,65 invece di $669,09. Una delle due conseguenze era che il tetto per mercato,
  // essendo il 20% del totale, si allargava insieme al totale gonfiato — $155,33 invece di $133,82.
  //
  // Col tetto FISSO quella conseguenza SPARISCE per costruzione: il tetto non dipende più dal totale,
  // quindi un totale gonfiato non può più allargare un limite di rischio. L'asserzione lo verifica
  // nella forma nuova, che è più forte di quella vecchia — non «il tetto è giusto perché il totale è
  // giusto», ma «il tetto è immune al totale».
  ok('il tetto è FISSO e non dipende dal totale', cap === MARKET_CAP_FIXED_USD, `$${cap}`);
  ok('  il totale GONFIATO non lo allarga più: era il difetto, ora è impossibile',
    capPerMarketUsd(776.65) === capPerMarketUsd(669.09), `$${capPerMarketUsd(776.65)} vs $${capPerMarketUsd(669.09)}`);
  ok('  e la misura del capitale resta quella corretta', Math.abs(totale - 669.09) < 0.01, `$${totale}`);

  // I tetti già scritti si riscrivono da soli: il salto supera la soglia del 5%.
  const TRIG = require('./trigger-capitale-fermo');
  const snapshot = { readable: true, error: null, updatedAt: Date.now() - 600_000, capital: 776.65,
    markets: { '0xaa': { capitalUsd: 84 } } };
  const d = TRIG.decidiTetti({ righe: [{ marketId: '0xaa', capital: 84 }], capPerMercatoUsd: cap,
    capitaleTotaleUsd: u.capitaleTotaleUsd, snapshot, mercatiAttivi: null, now: Date.now() });
  ok('i tetti scritti col numero gonfiato vengono riscritti al primo giro', d.scrivi === true, d.motivo);
  ok('  e col capitale vero', d.capital === TOTALE_VERO, `$${d.capital}`);
}

console.log('\n── 4 · NESSUNA SOMMA PUÒ SUPERARE IL TOTALE, E I RIFIUTI RESTANO');
{
  // Ordini a riposo maggiori del cash (portafoglio molto sbilanciato sul SELL): il libero va a zero,
  // mai negativo, e l'impegnato non supera mai il totale.
  const u = U.misuraUtilizzo({ saldoUsd: 50, ordiniARiposoUsd: 400, posizioniUsd: 300 });
  ok('il libero non va sotto zero', u.liberoUsd === 0, `$${u.liberoUsd}`);
  ok('  e l\'impegnato non supera il totale', u.impegnatoUsd === u.capitaleTotaleUsd, `$${u.impegnatoUsd} / $${u.capitaleTotaleUsd}`);
  ok('  utilizzo 100%, non oltre', u.pct === 100, `${u.pct}%`);

  // Senza ordini a riposo il libero è il cash intero: nessuna sottrazione fantasma.
  const senza = U.misuraUtilizzo({ saldoUsd: 500, ordiniARiposoUsd: 0, posizioniUsd: 100 });
  ok('senza ordini a riposo il libero è il cash intero', senza.liberoUsd === 500 && senza.capitaleTotaleUsd === 600);

  // Fail-closed invariati: una fonte illeggibile non produce un numero inventato.
  for (const [nome, a] of [
    ['saldo', { saldoUsd: null, ordiniARiposoUsd: 10, posizioniUsd: 10 }],
    ['ordini a riposo', { saldoUsd: 10, ordiniARiposoUsd: null, posizioniUsd: 10 }],
    ['posizioni', { saldoUsd: 10, ordiniARiposoUsd: 10, posizioniUsd: null }],
  ]) {
    const r = U.misuraUtilizzo(a);
    ok(`${nome} illeggibile ⇒ non misurabile`, r.leggibile === false && r.capitaleTotaleUsd === null, r.motivo.slice(0, 58));
  }
  const zero = U.misuraUtilizzo({ saldoUsd: 0, ordiniARiposoUsd: 0, posizioniUsd: 0 });
  ok('capitale a zero ⇒ non misurabile, non «100%»', zero.leggibile === false);
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

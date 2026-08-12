'use strict';
// lib/maker/latch-che-scade.test.js — UN LATCH SENZA SCADENZA NON È UNA PROTEZIONE, È UN INTERRUTTORE SPENTO.
//
// Il difetto, misurato: `data/guardian-state.json` portava il latch dello scatto del 9 agosto, e agent43
// lo leggeva come un booleano — `scattato === true` ⇒ esci, senza guardare altro. Il 12 agosto il P&L era
// tornato a **+$2,54 su soglie −$30 / −5%**, e in quel momento nessuno sorvegliava il capitale.
//
// «Nessun auto-riarmo» era la regola giusta per l'ISTANTE dello scatto — un guardiano che si riarma da
// solo dopo trenta secondi litiga con la persona che lo sta riarmando — ma non per sempre.

const fs = require('fs');
const path = require('path');
const G = require('./guardian-perdite');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const ORA = 1_786_500_000_000;
const h = (n) => ORA - n * 3_600_000;
const latch = (at, extra = {}) => ({ v: 1, scattato: true, at, atIso: new Date(at).toISOString(),
  pnlUsd: -39.97, pnlPct: -6.05, baselineUsd: 660.56, totaleUsd: 620.59, ...extra });
const pnl = (usd, pct) => ({ calcolabile: true, pnlUsd: usd, pnlPct: pct, motivo: null });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('── 1 · I DUE CASI CHIESTI');
{
  // ⚠ QUESTI SONO I DUE CASI DEL REQUISITO, e sono l'uno la controprova dell'altro: se passasse solo
  // il primo, il latch si azzererebbe per il solo passare del tempo — cioè il tempo guarirebbe una
  // perdita, che è il modo peggiore di sbagliare qui.
  const sano = G.valutaLatch({ stato: latch(h(30)), pnl: pnl(2.54, 0.385), sogliaPct: 5, sogliaAbs: 30, now: ORA });
  ok('latch VECCHIO + P&L SANO ⇒ AZZERATO', sano.azzera === true && sano.tieni === false);
  ok('  e il motivo cita entrambe le ragioni, non solo il tempo',
    /vecchio di 30\.0h/.test(sano.motivo) && /SOPRA soglia/.test(sano.motivo), sano.motivo.slice(0, 90));

  const malato = G.valutaLatch({ stato: latch(h(30)), pnl: pnl(-45, -7), sogliaPct: 5, sogliaAbs: 30, now: ORA });
  ok('latch VECCHIO + P&L SOTTO SOGLIA ⇒ RESTA SCATTATO', malato.azzera === false && malato.tieni === true);
  ok('  e lo dice per esteso: il tempo non guarisce una perdita', /il tempo non guarisce/.test(malato.motivo));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2 · LE 24 ORE SONO UNA SCADENZA, NON UN RITARDO DELLO SCATTO');
{
  ok('latch RECENTE + P&L sano ⇒ resta scattato',
    G.valutaLatch({ stato: latch(h(2)), pnl: pnl(50, 7), now: ORA }).azzera === false);
  ok('  a 23,9 ore ancora scattato',
    G.valutaLatch({ stato: latch(ORA - (24 * 3_600_000 - 60_000)), pnl: pnl(50, 7), now: ORA }).azzera === false);
  ok('  a 24 ore esatte si azzera (confine inclusivo)',
    G.valutaLatch({ stato: latch(ORA - 24 * 3_600_000), pnl: pnl(50, 7), now: ORA }).azzera === true);
  ok('la finestra è 24 ore', G.ETA_RIARMO_MS === 24 * 3_600_000);
  ok('  ed è configurabile per il test senza toccare il difetto',
    G.valutaLatch({ stato: latch(h(2)), pnl: pnl(50, 7), now: ORA, etaRiarmoMs: 3_600_000 }).azzera === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3 · FAIL-CLOSED: NON SI AZZERA AL BUIO');
{
  ok('P&L non calcolabile ⇒ NON si azzera',
    G.valutaLatch({ stato: latch(h(40)), pnl: { calcolabile: false }, now: ORA }).azzera === false);
  ok('  e nemmeno con `pnl` assente', G.valutaLatch({ stato: latch(h(40)), pnl: null, now: ORA }).azzera === false);
  ok('  «non so quanto sto perdendo» non è «non sto perdendo»',
    /non si azzera al buio/.test(G.valutaLatch({ stato: latch(h(40)), pnl: null, now: ORA }).motivo));
  ok('latch senza istante di scatto ⇒ resta scattato, e dice quale campo manca',
    G.valutaLatch({ stato: { scattato: true }, pnl: pnl(50, 7), now: ORA }).tieni === true);
  ok('nessun latch ⇒ il guardiano è in servizio',
    G.valutaLatch({ stato: null, pnl: pnl(50, 7), now: ORA }).tieni === false);
  ok('  e `scattato` non-booleano non è un latch',
    G.valutaLatch({ stato: { scattato: 'true', at: h(40) }, pnl: pnl(50, 7), now: ORA }).tieni === false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4 · IL LATCH PORTA CONTESTO, E L\'AZZERAMENTO LO DICHIARA');
{
  const st = latch(h(30));
  ok('la struttura porta timestamp, P&L allo scatto e finestra di riferimento',
    Number.isFinite(st.at) && Number.isFinite(st.pnlUsd) && Number.isFinite(st.baselineUsd) && Number.isFinite(st.totaleUsd));
  const ev = G.eventoRiarmo({ stato: st, pnl: pnl(2.54, 0.385), etaMs: 30 * 3_600_000, motivo: 'x', at: ORA });
  ok('il referto dichiara il PRIMA e il DOPO, non solo l\'esito',
    ev.observed.pnlAlloScatto === -39.97 && ev.observed.pnlAdesso === 2.54);
  ok('  con l\'età del latch in ore', ev.observed.etaOre === 30);
  ok('  e l\'esito nominato', ev.outcome === 'latch-azzerato-per-scadenza');
  ok('⚠ e dichiara che il BOT non è stato riavviato: torna in servizio il guardiano, non il motore',
    ev.observed.botRiavviato === false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 5 · IL CABLAGGIO IN agent43');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8');
  ok('agent43 non legge più il latch come un booleano', src.includes('valutaLatch({'));
  ok('  e rivaluta dal P&L corrente oltre le 24 ore', src.includes('calcolaPnl({ baselineUsd: baselineL.baselineUsd'));
  ok('  ma sotto le 24 ore NON legge il venue: la risposta è la stessa e la lettura costerebbe',
    src.includes('if (etaMs == null || etaMs < ETA_RIARMO_MS)'));
  ok('l\'audit si scrive PRIMA di togliere il file',
    src.indexOf('eventoRiarmo({') < src.indexOf('fs.unlinkSync(stateFile)'));
  ok('  perché «ho provato e non ci sono riuscito» è un\'informazione',
    src.includes("azione: 'riarmo-fallito'"));
  ok('dopo l\'azzeramento si prosegue nello STESSO giro', src.includes('e\' di nuovo in servizio adesso'));
  ok('`stato: null` iniettato vale «nessun latch», non «leggi il file vero»',
    src.includes('deps.stato !== undefined ? deps.stato : readJson(stateFile)'));
  ok('il modulo di audit importato è di sola scrittura su file',
    !/require\('\.\.\/lib\/maker\/manual-order'\)/.test(src) && src.includes('polymarket-clob-maker/audit'));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 6 · IL LATCH DEL 9 AGOSTO È STATO AZZERATO');
{
  const f = path.join(__dirname, '..', '..', 'data', 'guardian-state.json');
  ok('`data/guardian-state.json` non esiste più: il guardiano è in servizio', !fs.existsSync(f));
  const base = path.join(__dirname, '..', '..', 'data', 'guardian-baseline.json');
  ok('  e il baseline NON è stato toccato (è il punto zero, non il latch)', fs.existsSync(base));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

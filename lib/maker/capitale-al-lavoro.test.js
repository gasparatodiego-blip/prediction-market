'use strict';
// lib/maker/capitale-al-lavoro.test.js — IL CAPITALE STA AL LAVORO, E LA GERARCHIA NON HA SCORCIATOIE.
//
// Copre i sei requisiti dell'8 agosto 2026 con asserzioni sui MECCANISMI, non sui numeri di una corsa:
//   1 · il target di utilizzo esiste, si misura, e non inventa un numero quando un ingresso manca
//   2 · il giro pianifica PIU' mercati e si ferma sui vincoli veri (minimo, obiettivo, tetto, mercati nuovi)
//   3 · il trigger si ferma sul kill, e una forzatura salta le attese ma NON i cancelli di sicurezza
//   4 · la scoperta dei mercati non dipende dal capitale (ispezione del sorgente di agent24)
//   5 · NESSUN ramo di auto-close arriva alla vendita senza aver prima tentato la coppia
//   6 · agent40 inietta davvero il cancellatore, che tre percorsi aspettavano
//
// Nessun venue, nessuna rete, nessun file: ogni effetto e' iniettato. Run: node lib/maker/capitale-al-lavoro.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const UTIL = require('./utilizzo-capitale');
const TRIG = require('./trigger-capitale-fermo');
const { runAutoCloseCycle } = require('./auto-close');
const { MERGE_STRATEGY_ENABLED } = require('./strategia-merge');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n1 · il target di utilizzo: un metro, non un permesso');
// ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = UTIL.misuraUtilizzo({ saldoUsd: 100, ordiniARiposoUsd: 600, posizioniUsd: 300 });
  ok('misura il totale come liquido + ordini + posizioni', u.capitaleTotaleUsd === 1000, String(u.capitaleTotaleUsd));
  ok('l\'impegnato è ordini + posizioni', u.impegnatoUsd === 900, String(u.impegnatoUsd));
  ok('90% è raggiunto al 90% esatto', u.raggiunto === true && u.pct === 90, `${u.pct}%`);
  ok('nessun deficit quando è raggiunto', u.deficitUsd === 0);

  const v = UTIL.misuraUtilizzo({ saldoUsd: 668.25, ordiniARiposoUsd: 0, posizioniUsd: 0 });
  ok('capitale tutto liquido ⇒ utilizzo 0%', v.pct === 0 && v.raggiunto === false, `${v.pct}%`);
  ok('  e il deficit è in DOLLARI, non in punti', Math.abs(v.deficitUsd - 601.43) < 0.02, `$${v.deficitUsd}`);

  // IL DIFETTO CHE QUESTA GUARDIA ESISTE PER IMPEDIRE: un saldo illeggibile trattato come zero
  // direbbe «utilizzo 100%» proprio quando il capitale è fermo e nessuno lo sa.
  const w = UTIL.misuraUtilizzo({ saldoUsd: null, ordiniARiposoUsd: 500, posizioniUsd: 0 });
  ok('saldo illeggibile ⇒ NON misurabile (mai 100%)', w.leggibile === false && w.pct === null);
  ok('  e il motivo dice quale ingresso manca', /saldo/i.test(w.motivo), w.motivo.slice(0, 60));
  ok('posizioni illeggibili ⇒ NON misurabile', UTIL.misuraUtilizzo({ saldoUsd: 10, ordiniARiposoUsd: 0, posizioniUsd: null }).leggibile === false);

  ok('il target di difetto è 0,90', UTIL.TARGET_UTILIZZO === 0.90, String(UTIL.TARGET_UTILIZZO));
  ok('un MAKER_TARGET_UTILIZZO assurdo viene SCARTATO', UTIL.leggiTarget({ MAKER_TARGET_UTILIZZO: '7' }) === 0.90
    && UTIL.leggiTarget({ MAKER_TARGET_UTILIZZO: 'boh' }) === 0.90 && UTIL.leggiTarget({ MAKER_TARGET_UTILIZZO: '0.8' }) === 0.8);

  // Gli aggregatori: un ordine o una posizione illeggibile rende ignoto il TOTALE, non lo sottostima.
  ok('nozionaleARiposo somma prezzo × size', UTIL.nozionaleARiposo([{ price: 0.5, size: 10 }, { price: 0.2, sizeRemaining: 50 }]) === 15);
  ok('  un ordine con prezzo illeggibile rende ignoto il totale', UTIL.nozionaleARiposo([{ price: null, size: 10 }]) === null);
  ok('valorePosizioni usa il prezzo CORRENTE', UTIL.valorePosizioni([{ size: 32.27, curPrice: 0.8, avgPrice: 0.1 }]) === 25.816);
  ok('  una posizione senza prezzo rende ignoto il totale', UTIL.valorePosizioni([{ size: 10, curPrice: null, avgPrice: null }]) === null);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n2 · il giro pianifica più mercati, e si ferma sui vincoli veri');
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const righeFinte = [
  { marketId: '0xaa', capital: 120, mid: 0.5, pairCostUsd: 1, minSizeShares: 5, realisticBestPerDay: 9 },
  { marketId: '0xbb', capital: 120, mid: 0.5, pairCostUsd: 1, minSizeShares: 5, realisticBestPerDay: 8 },
  { marketId: '0xcc', capital: 120, mid: 0.5, pairCostUsd: 1, minSizeShares: 5, realisticBestPerDay: 7 },
  { marketId: '0xdd', capital: 120, mid: 0.5, pairCostUsd: 1, minSizeShares: 5, realisticBestPerDay: 6 },
];
{
  const g = TRIG.pianificaGiro({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 124 });
  ok('con $500 liberi tocca 4 mercati in UN giro', g.scelte.length === 4, `${g.scelte.length}`);
  ok('  in ordine di valore decrescente', g.scelte.map((s) => s.riga.marketId).join(',') === '0xaa,0xbb,0xcc,0xdd');
  ok('  e non riprende lo stesso mercato due volte', new Set(g.scelte.map((s) => s.riga.marketId)).size === 4);
  ok('  allocando $480 dei $500', g.allocatoUsd === 480, `$${g.allocatoUsd}`);

  // IL DIFETTO STORICO: `scegliMercato` da sola ne sceglieva UNO, e con un tetto al 20% servivano
  // cinque mini-cicli — cioè quasi un'ora di cooldown — per rimettere al lavoro capitale già libero.
  const uno = TRIG.scegliMercato({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 124 });
  ok('  (la funzione singola ne sceglieva UNO solo: è il difetto che questo chiude)', !!uno.riga && uno.allocatoUsd === 120);
}
{
  const g = TRIG.pianificaGiro({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 124, obiettivoImpegnoUsd: 200 });
  // Frena sul TOTALE, non sul numero di mercati: $120 + $80 = esattamente l'obiettivo, e il resto dei
  // $500 liberi non viene impegnato. È il verso giusto — il target è un tetto all'ambizione del giro,
  // non un permesso a spendere di più.
  ok('l\'obiettivo di impegno FRENA il giro', g.allocatoUsd === 200 && g.allocatoUsd < 480, `$${g.allocatoUsd} su ${g.scelte.length} mercati`);
  ok('  e lo dichiara', /obiettivo raggiunto|sotto il minimo/.test(g.motivoStop), g.motivoStop.slice(0, 50));
}
{
  const g = TRIG.pianificaGiro({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 124, maxMercati: 2 });
  ok('il tetto di mercati per giro morde', g.scelte.length === 2 && /tetto di 2 mercati/.test(g.motivoStop), g.motivoStop.slice(0, 40));
}
{
  // IL TETTO SUI MERCATI NUOVI VINCE SUL TARGET: il giro non si allenta per arrivare al 90%.
  // (Dal 9 agosto 2026 quel tetto non viene piu' da un contatore giornaliero ma dall'obiettivo di
  // utilizzo — `utilizzo-capitale.aperturaNuoviMercati`. Qui si prova il MECCANISMO, che e' lo stesso.)
  const g = TRIG.pianificaGiro({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 124,
    nuoviAmmessi: 2, motivoNuoviEsauriti: 'motivo di prova' });
  ok('il tetto limita i mercati NUOVI', g.scelte.length === 2, `${g.scelte.length}`);
  ok('  e lo dichiara invece di allentarsi', /sarebbe un mercato NUOVO/.test(g.motivoStop), g.motivoStop.slice(0, 40));
  ok('  riportando la ragione VERA di chi l\'ha deciso', /motivo di prova/.test(g.motivoStop));

  // Un mercato già aperto NON consuma un posto.
  const h = TRIG.pianificaGiro({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: { '0xaa': 20 }, capPerMercatoUsd: 124, nuoviAmmessi: 1 });
  ok('  un mercato già aperto non consuma un posto', h.scelte.length === 2 && h.scelte[0].nuovo === false, `${h.scelte.length}`);
}
{
  const mappa = { '0xaa': 10 };
  TRIG.pianificaGiro({ righe: righeFinte, disponibileUsd: 500, notionalePerMercato: mappa, capPerMercatoUsd: 124 });
  ok('non modifica la mappa che riceve', mappa['0xaa'] === 10, JSON.stringify(mappa));
}
{
  // Il predicato sulle gambe continua a valere e a NON fermare il giro: la riga rotta si salta.
  const g = TRIG.pianificaGiro({
    righe: righeFinte, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 124,
    gambeCostruibili: (r) => (r.marketId === '0xaa' ? { ok: false, motivo: 'tick nullo' } : { ok: true }),
  });
  ok('una riga con gambe non costruibili si salta, non ferma il giro',
    g.scelte.length === 3 && !g.scelte.some((s) => s.riga.marketId === '0xaa'), `${g.scelte.length}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n3 · il trigger: il kill davanti, e una forzatura che salta solo le attese');
// ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const base = { abilitato: true, botAttivo: true, saldo: { readable: true, usd: 600 }, now: 1_000_000 };
  ok('senza ostacoli scatta', TRIG.decidiTrigger(base).scatta === true);

  const k = TRIG.decidiTrigger({ ...base, killAttivo: true });
  ok('il KILL ferma il trigger PRIMA del ricalcolo', k.scatta === false && /kill/i.test(k.motivo), k.motivo.slice(0, 50));

  const cool = { ...base, ultimoTriggerAt: 1_000_000 - 60_000 };
  ok('il cooldown ferma un giro periodico', TRIG.decidiTrigger(cool).scatta === false);
  ok('  ma una forzatura da AVVIA lo salta', TRIG.decidiTrigger({ ...cool, ignoraAttese: true }).scatta === true);
  ok('  e la forzatura si vede nell\'esito', TRIG.decidiTrigger({ ...cool, ignoraAttese: true }).forzato === true);

  const quiete = { ...base, ultimoCicloAt: 1_000_000 - 10_000 };
  ok('la quiete dopo un ciclo ferma un giro periodico', TRIG.decidiTrigger(quiete).scatta === false);
  ok('  e anche questa la forzatura la salta', TRIG.decidiTrigger({ ...quiete, ignoraAttese: true }).scatta === true);

  // LE TRE COSE CHE UNA FORZATURA NON PUO' SALTARE, ed è il punto: «salta le attese» non è «salta tutto».
  ok('una forzatura NON salta il bot FERMO', TRIG.decidiTrigger({ ...base, botAttivo: false, ignoraAttese: true }).scatta === false);
  ok('una forzatura NON salta il kill', TRIG.decidiTrigger({ ...base, killAttivo: true, ignoraAttese: true }).scatta === false);
  ok('una forzatura NON salta il lucchetto del ciclo', TRIG.decidiTrigger({ ...base, cicloInCorso: true, ignoraAttese: true }).scatta === false);
  ok('una forzatura NON piazza su saldo illeggibile',
    TRIG.decidiTrigger({ ...base, saldo: { readable: false, error: 'rpc' }, ignoraAttese: true }).scatta === false);
  ok('una forzatura NON piazza sotto la soglia',
    TRIG.decidiTrigger({ ...base, saldo: { readable: true, usd: 10 }, ignoraAttese: true }).scatta === false);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n4 · la scoperta dei mercati non dipende dal capitale');
// ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  // Il ciclo di scansione deve essere un intervallo fisso, non una funzione di quanto capitale è libero.
  ok('agent24 scandisce a cadenza fissa', /SCAN_INTERVAL_MS\s*=\s*15\s*\*\s*60_000/.test(src));
  // Nessuna di queste tre letture deve comparire: sono i tre modi in cui la scoperta potrebbe finire
  // legata al capitale (saldo, interruttore, allowlist).
  for (const [nome, re] of [
    ['il saldo', /leggiSaldoUsd|pusdBalance|api\/rewards\/balance/],
    ['l\'interruttore AVVIA/FERMA', /botAttivo|bot-enabled/],
    ['la allowlist dei mercati gestiti', /enabledMarketIds|auto-reprice-config/],
  ]) ok(`  non legge ${nome}`, !re.test(src));
  ok('  e i livelli di capitale sono costanti di REPORT, non ingressi', /CAPITAL_LEVELS/.test(src) && !/CAPITAL_LEVELS\s*=\s*\[[^\]]*saldo/i.test(src));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n5 · NESSUN ramo arriva alla vendita senza aver prima tentato la coppia');
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const MERCATO = '0x' + 'ab'.repeat(32);
const TOK_YES = '111';
const TOK_NO = '222';
const CHIAVE = `${MERCATO}:${TOK_YES}`;

function registroFinto(iniziale = {}) {
  const m = new Map(Object.entries(iniziale));
  return { leggi: (k) => m.get(k) || null, segna: (k, r) => m.set(k, r), pulisci: (k) => m.delete(k), _m: m };
}

/** Il ciclo vero, con ogni effetto iniettato. `cancellatore:null` riproduce agent40 prima del fix. */
async function ciclo({
  asks = [{ price: 0.90, size: 100 }], ordini = [], registro = registroFinto(),
  now = 5_000_000, cancellatore = async () => ({ ok: true }), piazzamento = null,
} = {}) {
  const piazzati = []; const cancellati = [];
  const res = await runAutoCloseCycle({
    now: () => now,
    marketIds: [MERCATO],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize: 5, maxSpreadCents: 4.5,
      books: { yes: { scoringMid: 0.80, bestBid: 0.79 }, no: { scoringMid: 0.20, bestBid: 0.19 } },
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_YES, size: 32.27, avgPrice: 0.80 }] }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    readDepth: () => ({ readable: true, yes: { asks: null }, no: { asks } }),
    attesaMerge: registro,
    placeOrder: async (spec) => {
      piazzati.push(spec);
      if (piazzamento) return piazzamento(spec);
      return { ok: true, sent: true, orderId: 'ord-' + piazzati.length };
    },
    ...(cancellatore ? { cancelOrder: async (s) => { cancellati.push(s); return cancellatore(s); } } : {}),
    audit: () => {},
  });
  return { res, piazzati, cancellati, registro };
}

// L'uscita a riposo che copre l'intera posizione, vecchia di 25 ore ⇒ il trigger max-wait è scattato.
const USCITA_VECCHIA = { orderId: 'uscita-1', tokenId: TOK_YES, side: 'SELL', size: 32.27, price: 0.81, createdMs: 5_000_000 - 25 * 3600_000 };
// La stessa, appena messa ⇒ nessun trigger: il ramo `already-covered` puro.
const USCITA_NUOVA = { orderId: 'uscita-2', tokenId: TOK_YES, side: 'SELL', size: 32.27, price: 0.81, createdMs: 5_000_000 - 60_000 };

(async () => {
  ok('il merge è acceso (premessa del Requisito 6)', MERGE_STRATEGY_ENABLED === true);

  // ── 5a · RAMO «already-covered»: prima era una scorciatoia muta ────────────────────────────────
  {
    const { piazzati, cancellati } = await ciclo({ ordini: [USCITA_NUOVA] });
    ok('already-covered · tenta la coppia invece di limitarsi ad aspettare',
      piazzati.length === 1 && piazzati[0].side === 'BUY' && piazzati[0].book === 'no', JSON.stringify(piazzati.map((p) => p.side + '/' + p.book)));
    ok('  e toglie PRIMA l\'uscita a riposo', cancellati.length === 1 && cancellati[0].orderId === 'uscita-2');
    ok('  non vende niente in quel giro', !piazzati.some((p) => p.side === 'SELL'));
  }
  {
    // Se la cancellazione non riesce, NON si compra: l'uscita resta dov'era e si aspetta come prima.
    const { piazzati, cancellati } = await ciclo({ ordini: [USCITA_NUOVA], cancellatore: async () => ({ ok: false, reason: 'venue muto' }) });
    ok('already-covered · cancellazione fallita ⇒ non compra e non vende', piazzati.length === 0 && cancellati.length === 1);
  }
  {
    // E se il merge rinuncia DOPO aver cancellato, l'uscita torna sul libro nello STESSO ciclo.
    let n = 0;
    const { piazzati } = await ciclo({
      ordini: [USCITA_NUOVA],
      piazzamento: (s) => { n += 1; return s.side === 'BUY' ? { ok: false, gate: 'test', reason: 'rifiutato' } : { ok: true, sent: true, orderId: 'x' + n }; },
    });
    ok('already-covered · rinuncia dopo la cancellazione ⇒ l\'uscita si ripiazza SUBITO',
      piazzati.some((p) => p.side === 'SELL'), JSON.stringify(piazzati.map((p) => p.side)));
  }

  // ── 5b · RAMO «close-at-market»: il caso Schwartzel ────────────────────────────────────────────
  {
    // Ask conveniente ⇒ Livello 1 disponibile. Prima: la chiusura forzata vinceva sempre e vendeva.
    const { piazzati, cancellati } = await ciclo({ ordini: [USCITA_VECCHIA], asks: [{ price: 0.15, size: 100 }] });
    ok('close-at-market · con la coppia conveniente NON vende al bid',
      !piazzati.some((p) => p.side === 'SELL'), JSON.stringify(piazzati.map((p) => p.side + '/' + p.book)));
    ok('  compra il secondo lato come ULTIMO tentativo', piazzati.length === 1 && piazzati[0].side === 'BUY' && piazzati[0].book === 'no');
    ok('  dopo aver tolto l\'uscita scaduta', cancellati.some((c) => c.orderId === 'uscita-1'));
  }
  {
    // Livello 3 (attesa del merge scaduta) ⇒ la chiusura forzata deve tornare a vendere davvero.
    const reg = registroFinto({ [CHIAVE]: { at: 5_000_000 - 61 * 60_000, orderId: 'compl-1' } });
    const { piazzati } = await ciclo({ ordini: [USCITA_VECCHIA], registro: reg });
    ok('close-at-market · a merge scaduto vende davvero (il merge non è un rinvio infinito)',
      piazzati.some((p) => p.side === 'SELL'), JSON.stringify(piazzati.map((p) => p.side)));
  }
  {
    // IL BUG DI SCHWARTZEL: senza cancellatore iniettato, la chiusura forzata non arrivava mai in fondo.
    const { piazzati, res } = await ciclo({ ordini: [USCITA_VECCHIA], asks: [{ price: 0.15, size: 100 }], cancellatore: null });
    ok('close-at-market · senza cancellatore non vende e non compra (fallisce nel verso sicuro)', piazzati.length === 0);
    ok('  e lo dichiara invece di dire «ignoto»',
      JSON.stringify(res.actions).includes('cancel'), JSON.stringify(res.actions.map((a) => a.action || a.gate)).slice(0, 90));
  }

  // ── 5c · RAMO «uscita ordinaria»: il comportamento noto non è cambiato ─────────────────────────
  {
    const { piazzati, registro } = await ciclo({ ordini: [] });
    ok('uscita ordinaria · la coppia viene prima della vendita', piazzati.length === 1 && piazzati[0].side === 'BUY');
    ok('  e l\'orologio del Livello 2 parte', registro._m.size === 1);
  }

  // ── 5d · PIU' AGGRESSIVO: il Livello 1 si prende anche mentre il Livello 2 aspetta ─────────────
  {
    const reg = registroFinto({ [CHIAVE]: { at: 5_000_000 - 10 * 60_000, orderId: 'compl-1', prezzo: 0.19, size: 32.27 } });
    const { piazzati, cancellati } = await ciclo({ ordini: [], asks: [{ price: 0.15, size: 100 }], registro: reg });
    ok('attesa in corso · se l\'ask scende dentro il tetto si passa al Livello 1',
      piazzati.length === 1 && piazzati[0].attraversaApposta === true, JSON.stringify(piazzati.map((p) => p.side + (p.attraversaApposta ? '/taker' : '/maker'))));
    ok('  togliendo prima il completamento a riposo', cancellati.some((c) => c.orderId === 'compl-1'));
    ok('  e l\'attesa vecchia non resta a puntare a un ordine cancellato', !reg._m.has(CHIAVE) || reg._m.get(CHIAVE).orderId !== 'compl-1');
  }
  {
    // Se invece l'ask NON scende, un'attesa in corso resta un'attesa: nessun secondo ordine.
    const reg = registroFinto({ [CHIAVE]: { at: 5_000_000 - 10 * 60_000, orderId: 'compl-1' } });
    const { piazzati } = await ciclo({ ordini: [], asks: [{ price: 0.90, size: 100 }], registro: reg });
    ok('attesa in corso · con l\'ask ancora cara non si piazza un secondo completamento', piazzati.length === 0);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n6 · agent40 inietta il cancellatore che tre percorsi aspettavano');
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
    const i = src.indexOf('async function closeTask');
    const j = src.indexOf('audit: (rec)', i);
    const blocco = src.slice(i, j);
    ok('closeTask inietta cancelOrder', /cancelOrder:\s*\(spec\)\s*=>\s*cancelManualOrder/.test(blocco));
    ok('  insieme a readDepth e al registro delle attese', /readDepth:/.test(blocco) && /attesaMerge:/.test(blocco));
    // La lettura della PROVA che serviva: prima del fix il blocco non lo conteneva.
    ok('  e il ciclo di riprezzo continua ad avere il suo', /cancelOrder:\s*\(spec\)\s*=>\s*cancelManualOrder\(spec,\s*'auto-reprice-band-exit'\)/.test(src));
  }
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    ok('agent41 sorveglia l\'interruttore per l\'AVVIA a freddo', /function sorvegliaAvvio/.test(src) && /forzatoDa: 'AVVIA appena premuto'/.test(src));
    ok('  e il mini-ciclo sa RICALCOLARE quando il piano salvato non basta', /ricalcola\(\{ capital: decisione\.saldoUsd/.test(src));
    ok('  il piano leggero non sovrascrive la memoria del ciclo pesante',
      /async function pianoLeggero[\s\S]{0,900}calcolaPianoFuoriProcesso/.test(src) && !/async function pianoLeggero[\s\S]{0,900}scriviUltimoPiano/.test(src));
    ok('  e il kill è un cancello del trigger, non solo un rifiuto a valle', /killAttivo,/.test(src));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

assert.ok(true);

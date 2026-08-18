'use strict';
// lib/maker/tetti-dal-miniciclo.test.js — I TETTI SEGUONO IL CAPITALE, NON L'ORA IN CUI FURONO SCRITTI.
//
// ═══ IL DIFETTO, MISURATO IL 9 AGOSTO 2026 ══════════════════════════════════════════════════════════
// `data/maker-allocated-capital.json` — la fotografia del tetto di capitale per mercato — la scriveva
// SOLO il ciclo fisso da 6h, dopo un reset riuscito (`realloc-cycle.js:479`). Il mini-ciclo ricalcola un
// piano fresco ogni ~10 minuti e non l'ha mai scritta. Alle 06:37 la fotografia era ancora quella delle
// **03:42**: dodici mercati, `capital: 600`, i tetti che sommavano **esattamente $600**.
//
// Nel frattempo il capitale totale era **$850,82** (libero $606,28 + impegnato $244,54).
//
//   utilizzo massimo teorico = 600 / 850,82 = 70,5%   contro un obiettivo del 90%
//
// Il riallocatore dichiarava «utilizzo 28,7%, mancano $521,20» e si fermava con «nessun mercato del
// piano ha spazio sufficiente adesso» — 27 giri su 259. Il deficit era reale, ma nessun piano poteva
// colmarlo: i tetti contro cui lo spazio veniva misurato erano quelli di un capitale che non c'era più.
//
// E c'era un secondo effetto, sullo stesso file: i mercati che il piano fresco sceglieva e la fotografia
// vecchia non conosceva restavano SENZA tetto, e a valle un tetto assente vale «nessuna esposizione
// nuova». È l'origine di `saltato-tetto-non-leggibile`, dieci volte su Dallas (`cid_a7245f90…`), il
// mercato su cui tenevamo una coppia completa.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · il caso vero: $600 → $850,82, i tetti si aggiornano e il 90% torna raggiungibile
//   2 · Dallas non è più senza tetto — end-to-end, scrivendo e rileggendo un file vero
//   3 · stabilità: non si riscrive a ogni giro, solo quando cambia qualcosa davvero
//   4 · unione e potatura: chi ha del nostro denaro non perde mai il tetto
//   5 · il clamp al tetto di concentrazione, e i rifiuti fail-closed
//   6 · il cablaggio in agent41, e il ciclo da 6h lasciato intatto

const fs = require('fs');
const os = require('os');
const path = require('path');
const TRIG = require('./trigger-capitale-fermo');
const AC = require('./allocated-capital');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// ── I NUMERI VERI DELL'INCIDENTE ────────────────────────────────────────────────────────────────────
const CAPITALE_ALLORA = 600;
const CAPITALE_ORA = 850.8179;
const CAP_MERCATO = 170.16;            // 20% di 850,8179, dal modulo della concentrazione
const DALLAS = '0xa7245f903c604b2a0ddbd9a454600395d06e0e2d4f28f8fe227fffdbb923a1c1';
const LONDRA19 = '0xcf92c77731a57d1fae661041114345536498c149514871c40920bc9566447bc2';
const POLLNOW = '0xab464e4d5cb61f6dbd0d01375a85727113374f8dbcbf09efa70385c7904f2b80';

// La fotografia delle 03:42, copiata dal file di produzione: dodici mercati, somma $600.
const TETTI_0342 = {
  '0x67aa248ac06f8dfabba313bcffc3421f27f016099c3c9d77b483f4c444c5e095': { capitalUsd: 24 },
  '0xe56516b5fe2de527a4eb23481610fa099c05896e8749dd7c55fbeea8be9e02af': { capitalUsd: 36 },
  [LONDRA19]: { capitalUsd: 60 },
  '0xf04a40396adecfb48ab36f678d7c7d0fe79c44d7054d586c04a39ff17efeb68a': { capitalUsd: 24 },
  '0x07d63f88a5d8be7479affff5c941c84359a8c48554e5612aea94213686add76e': { capitalUsd: 60 },
  '0x0977f25e40d4bbc770246f6fa75c7353ce11a950a7c20ca83bb48ffb122c34df': { capitalUsd: 60 },
  '0x4e89a3305f50e611c10fc20b34f1f5df9f65cd1dd829b2b64487e848be57d955': { capitalUsd: 60 },
  '0x90c1c61f58e473e32687321a7964f08cf64dc392e47db01164755cedd1a7830f': { capitalUsd: 120 },
  [POLLNOW]: { capitalUsd: 48 },
  '0x59e4fbe18026e31402b650629333a0e447db354b44485219f676da0aeec94d6a': { capitalUsd: 36 },
  '0x9931891d2bc169abbad3cceca0774043f3573d3bf80c71885d02aa1e82f542e0': { capitalUsd: 24 },
  '0x62eb8811feca0b30929a7fe56c0f9197c5045a82862528309be29c649c3a6445': { capitalUsd: 48 },
};
const ORE_3 = 3 * 3_600_000;
const ADESSO = 1_786_257_000_000;
const fotografia0342 = () => ({
  readable: true, error: null, markets: JSON.parse(JSON.stringify(TETTI_0342)),
  updatedAt: ADESSO - ORE_3, ageSec: ORE_3 / 1000, capital: CAPITALE_ALLORA,
});
const somma = (rows) => +rows.reduce((t, r) => t + r.capital, 0).toFixed(2);

console.log('── 1 · IL CASO VERO: $600 → $850,82, E IL 90% TORNA RAGGIUNGIBILE');
{
  const prima = Object.values(TETTI_0342).reduce((t, r) => t + r.capitalUsd, 0);
  ok('la fotografia delle 03:42 sommava esattamente $600', prima === 600, `$${prima}`);
  ok('  cioè un utilizzo massimo del 70,5% contro un obiettivo del 90%',
    Math.round((prima / CAPITALE_ORA) * 1000) / 10 === 70.5, `${((prima / CAPITALE_ORA) * 100).toFixed(1)}%`);

  // Il piano di adesso: gli stessi mercati ancora validi, ridimensionati sul capitale vero, più Dallas.
  const righe = [
    { marketId: LONDRA19, capital: 85 }, { marketId: POLLNOW, capital: 84 },
    { marketId: DALLAS, capital: 120 },
    { marketId: '0x07d63f88a5d8be7479affff5c941c84359a8c48554e5612aea94213686add76e', capital: 85 },
    { marketId: '0x0977f25e40d4bbc770246f6fa75c7353ce11a950a7c20ca83bb48ffb122c34df', capital: 85 },
    { marketId: '0x90c1c61f58e473e32687321a7964f08cf64dc392e47db01164755cedd1a7830f', capital: 170 },
    { marketId: '0x4e89a3305f50e611c10fc20b34f1f5df9f65cd1dd829b2b64487e848be57d955', capital: 85 },
  ];
  const d = TRIG.decidiTetti({
    righe, capPerMercatoUsd: CAP_MERCATO, capitaleTotaleUsd: CAPITALE_ORA,
    snapshot: fotografia0342(), mercatiAttivi: null, now: ADESSO,
  });
  ok('si decide di scrivere', d.scrivi === true, d.motivo);
  ok('  e il capitale registrato è quello VERO, non quello di allora', d.capital === 850.82, String(d.capital));
  const dopo = somma(d.rows);
  ok('  la somma dei tetti supera i $600 di prima', dopo > 600, `$${dopo}`);
  ok('  e supera il 90% del capitale: l\'obiettivo torna raggiungibile',
    dopo >= CAPITALE_ORA * 0.9, `$${dopo} contro $${(CAPITALE_ORA * 0.9).toFixed(2)} richiesti`);
  ok('  nessun mercato oltre il tetto di concentrazione',
    d.rows.every((r) => r.capital <= CAP_MERCATO), `max $${Math.max(...d.rows.map((r) => r.capital))}`);
}

console.log('\n── 2 · DALLAS NON È PIÙ SENZA TETTO (end-to-end, su un file vero)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tetti-'));
  const file = path.join(dir, 'maker-allocated-capital.json');
  const dep = { allocatedCapitalFile: file };

  // LO STATO DI PARTENZA: la fotografia delle 03:42, che Dallas non conosce.
  AC.writeAllocatedCapital({
    rows: Object.entries(TETTI_0342).map(([marketId, r]) => ({ marketId, capital: r.capitalUsd })),
    capital: CAPITALE_ALLORA,
  }, dep);

  const prima = AC.readAllocatedCapital(DALLAS, dep);
  ok('PRIMA: Dallas non ha tetto', prima.capUsd === null, prima.reason);
  ok('  ed è esattamente il motivo che produceva «saltato-tetto-non-leggibile»',
    /non compare nel piano di allocazione corrente/.test(prima.reason));

  // Il mini-ciclo ricalcola e Dallas entra nel piano.
  const d = TRIG.decidiTetti({
    righe: [{ marketId: DALLAS, capital: 120 }, { marketId: LONDRA19, capital: 60 }],
    capPerMercatoUsd: CAP_MERCATO, capitaleTotaleUsd: CAPITALE_ORA,
    snapshot: AC.readAllocatedCapitalAll(dep), mercatiAttivi: null, now: Date.now(),
  });
  ok('Dallas risulta fra i mercati AGGIUNTI', d.aggiunti.includes(DALLAS), d.aggiunti.length + ' aggiunti');
  const w = AC.writeAllocatedCapital({ rows: d.rows, capital: d.capital, by: 'riallocatore · trigger capitale fermo' }, dep);
  ok('  la scrittura riesce', w.ok === true, `${w.marketCount} mercati`);

  const dopo = AC.readAllocatedCapital(DALLAS, dep);
  ok('DOPO: Dallas ha un tetto leggibile', dopo.capUsd === 120, `$${dopo.capUsd} · ${dopo.reason}`);
  ok('  e nessun altro mercato ha perso il suo', AC.readAllocatedCapital(POLLNOW, dep).capUsd === 48,
    `Pollnow $${AC.readAllocatedCapital(POLLNOW, dep).capUsd}`);
  ok('  la provenienza è distinguibile da quella del ciclo da 6h',
    JSON.parse(fs.readFileSync(file, 'utf8')).by === 'riallocatore · trigger capitale fermo');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n── 3 · STABILITÀ: NON SI RISCRIVE A OGNI GIRO');
{
  const righe = [{ marketId: LONDRA19, capital: 85 }, { marketId: POLLNOW, capital: 84 }];
  const base = { righe, capPerMercatoUsd: CAP_MERCATO, capitaleTotaleUsd: CAPITALE_ORA, mercatiAttivi: null, now: ADESSO };
  const primo = TRIG.decidiTetti({ ...base, snapshot: fotografia0342() });
  ok('il primo giro scrive', primo.scrivi === true, primo.motivo);

  // La fotografia che ne risulta, riletta al giro dopo: dieci minuti, stessi numeri.
  const dopoIlPrimo = {
    readable: true, error: null, updatedAt: ADESSO, ageSec: 0, capital: primo.capital,
    markets: Object.fromEntries(primo.rows.map((r) => [r.marketId, { capitalUsd: r.capital }])),
  };
  const secondo = TRIG.decidiTetti({ ...base, snapshot: dopoIlPrimo, now: ADESSO + 600_000 });
  ok('il giro dopo NON riscrive', secondo.scrivi === false, secondo.motivo);
  ok('  e non è perché non ha calcolato niente', secondo.rows.length === primo.rows.length, `${secondo.rows.length} tetti`);

  // Un capitale che oscilla di poco non muove niente: sotto le soglie non è un cambiamento.
  const briciola = TRIG.decidiTetti({ ...base, capitaleTotaleUsd: CAPITALE_ORA + 12, snapshot: dopoIlPrimo, now: ADESSO + 600_000 });
  ok('un capitale che si muove dell\'1,4% non fa riscrivere', briciola.scrivi === false, briciola.motivo);
  const vero = TRIG.decidiTetti({ ...base, capitaleTotaleUsd: CAPITALE_ORA + 200, snapshot: dopoIlPrimo, now: ADESSO + 600_000 });
  ok('  ma un capitale che si muove del 23% sì', vero.scrivi === true, vero.motivo);

  // Un tetto che si sposta di poco è arrotondamento, non una decisione nuova.
  const quasi = TRIG.decidiTetti({ ...base, righe: [{ marketId: LONDRA19, capital: 85.4 }, { marketId: POLLNOW, capital: 84 }],
    snapshot: dopoIlPrimo, now: ADESSO + 600_000 });
  ok('un tetto che si sposta di $0,40 non fa riscrivere', quasi.scrivi === false, quasi.motivo);
  const molto = TRIG.decidiTetti({ ...base, righe: [{ marketId: LONDRA19, capital: 140 }, { marketId: POLLNOW, capital: 84 }],
    snapshot: dopoIlPrimo, now: ADESSO + 600_000 });
  ok('  ma uno che passa da $85 a $140 sì', molto.scrivi === true, molto.motivo);

  // La fotografia non deve poter invecchiare fino alle 24h in cui vale zero.
  const vecchia = { ...dopoIlPrimo, updatedAt: ADESSO - 13 * 3_600_000 };
  const rinfresco = TRIG.decidiTetti({ ...base, snapshot: vecchia, now: ADESSO });
  ok('una fotografia di 13 h viene rinfrescata prima di scadere a 24 h', rinfresco.scrivi === true, rinfresco.motivo);
  ok('  e il motivo lo dice, così un ciclo da 6h fermo non resta invisibile', /rinfresco/.test(rinfresco.motivo));
}

console.log('\n── 4 · UNIONE E POTATURA: CHI HA DEL NOSTRO DENARO NON PERDE MAI IL TETTO');
{
  const righe = [{ marketId: DALLAS, capital: 120 }];
  const comune = { righe, capPerMercatoUsd: CAP_MERCATO, capitaleTotaleUsd: CAPITALE_ORA, now: ADESSO };

  // Senza elenco dei mercati attivi non si pota niente: «non ho potuto guardare» non è «non c'è niente».
  const cieco = TRIG.decidiTetti({ ...comune, snapshot: fotografia0342(), mercatiAttivi: null });
  ok('senza l\'elenco dei mercati attivi non si pota nulla', cieco.potati.length === 0, `${cieco.rows.length} tetti`);
  ok('  e i dodici vecchi sopravvivono tutti accanto al nuovo', cieco.rows.length === 13, String(cieco.rows.length));

  // Con l'elenco: sopravvive chi è nel piano o dove c'è del nostro denaro.
  const conElenco = TRIG.decidiTetti({ ...comune, snapshot: fotografia0342(), mercatiAttivi: [LONDRA19, POLLNOW] });
  const ids = conElenco.rows.map((r) => r.marketId);
  ok('un mercato con ordini a riposo resta', ids.includes(LONDRA19));
  ok('  e anche uno con una posizione aperta', ids.includes(POLLNOW));
  ok('  il mercato del piano c\'è', ids.includes(DALLAS));
  ok('  e i dieci senza niente escono', conElenco.potati.length === 10, `${conElenco.potati.length} potati`);
  ok('  la potatura da sola basta a far scrivere', conElenco.scrivi === true, conElenco.motivo);

  // Il piano di adesso vince sul vecchio per i mercati che nomina; il silenzio non cancella.
  const sovrascrive = TRIG.decidiTetti({
    ...comune, righe: [{ marketId: LONDRA19, capital: 150 }], snapshot: fotografia0342(), mercatiAttivi: null,
  });
  const l19 = sovrascrive.rows.find((r) => r.marketId === LONDRA19);
  ok('il piano di adesso sposta il tetto di un mercato che già c\'era', l19 && l19.capital === 150, `$${l19 && l19.capital}`);
  ok('  e i mercati su cui non dice niente restano com\'erano',
    sovrascrive.rows.find((r) => r.marketId === POLLNOW).capital === 48);
}

console.log('\n── 5 · IL CLAMP, E I RIFIUTI');
{
  // Le righe di un piano SALVATO furono decise contro un capitale di allora, che può essere stato più
  // grande: il clamp al tetto di concentrazione è sempre verso il basso.
  const d = TRIG.decidiTetti({
    righe: [{ marketId: DALLAS, capital: 300 }], capPerMercatoUsd: CAP_MERCATO,
    capitaleTotaleUsd: CAPITALE_ORA, snapshot: fotografia0342(), mercatiAttivi: null, now: ADESSO,
  });
  const dal = d.rows.find((r) => r.marketId === DALLAS);
  ok('una riga da $300 viene tagliata al tetto di concentrazione', dal.capital === CAP_MERCATO, `$${dal.capital}`);

  // Fail-closed: non si sovrascrive ciò che non si è potuto leggere.
  for (const [nome, snap] of [
    ['fotografia illeggibile', { readable: false, error: 'EACCES', markets: {} }],
    ['nessuna fotografia', null],
  ]) {
    const r = TRIG.decidiTetti({ righe: [{ marketId: DALLAS, capital: 120 }], capPerMercatoUsd: CAP_MERCATO,
      capitaleTotaleUsd: CAPITALE_ORA, snapshot: snap, now: ADESSO });
    ok(`${nome} ⇒ non si scrive`, r.scrivi === false && r.rows.length === 0, r.motivo);
  }
  for (const righe of [[], [{ marketId: DALLAS, capital: 0 }], [{ marketId: '', capital: 50 }], [{ marketId: DALLAS, capital: NaN }]]) {
    const r = TRIG.decidiTetti({ righe, capPerMercatoUsd: CAP_MERCATO, capitaleTotaleUsd: CAPITALE_ORA,
      snapshot: fotografia0342(), now: ADESSO });
    ok(`righe ${JSON.stringify(righe)} ⇒ non si scrive`, r.scrivi === false, r.motivo);
  }
  // Senza tetto di concentrazione leggibile non si inventa un clamp: si prende ciò che il piano dice.
  const senzaCap = TRIG.decidiTetti({ righe: [{ marketId: DALLAS, capital: 300 }], capPerMercatoUsd: null,
    capitaleTotaleUsd: CAPITALE_ORA, snapshot: fotografia0342(), mercatiAttivi: null, now: ADESSO });
  ok('senza tetto di concentrazione si usa il valore del piano', senzaCap.rows.find((r) => r.marketId === DALLAS).capital === 300);
}

console.log('\n── 6 · IL CABLAGGIO, E IL CICLO DA 6H LASCIATO INTATTO');
{
  const ag = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  const rc = fs.readFileSync(path.join(__dirname, 'realloc-cycle.js'), 'utf8');

  ok('agent41 chiama decidiTetti', /TRIG\.decidiTetti\(/.test(ag));
  ok('  con entrambe le dipendenze iniettabili', /deps\.leggiTetti/.test(ag) && /deps\.scriviTetti/.test(ag));
  ok('  e passa una provenienza distinguibile', /by: 'riallocatore · trigger capitale fermo'/.test(ag));

  // I tetti devono esistere PRIMA che le gambe partano: se il passo 5 venisse prima, il primo fill
  // troverebbe ancora la fotografia vecchia.
  const iTetti = ag.indexOf('TRIG.decidiTetti(');
  const lePosa = ag.indexOf('// 5 · LE GAMBE DI OGNI MERCATO SCELTO');
  ok('  e lo fa PRIMA di costruire le gambe', iTetti > 0 && lePosa > iTetti, `tetti@${iTetti} < gambe@${lePosa}`);

  // Una scrittura fallita non deve fermare il giro: un tetto mancante fa già fallire chiuso a valle,
  // fermare il mini-ciclo lascerebbe fermo del capitale per un file.
  const blocco = ag.slice(iTetti - 900, iTetti + 1400);
  ok('  una scrittura fallita non ferma il giro', /catch \(e\) \{\s*referto\.tetti/.test(blocco));

  // Il ciclo da 6h è l'unico che parla a nome di TUTTO il piano, e resta a sostituzione piena.
  ok('il ciclo da 6h scrive ancora i tetti dopo il reset', /reset\.ok && !dryRunOnly && typeof deps\.writeAllocatedCapital/.test(rc));
  ok('  e non è stato toccato: nessuna unione, nessuna soglia', !/decidiTetti|mercatiAttivi/.test(rc));

  // La semantica del modulo resta UNA: sostituisce. L'unione la costruisce chi ne ha bisogno.
  const acSrc = fs.readFileSync(path.join(__dirname, 'allocated-capital.js'), 'utf8');
  ok('allocated-capital resta a sostituzione piena, senza modalità', !/modo|merge|unisci/.test(acSrc));

  // ── LA TRAPPOLA CHE QUESTO CAMBIO HA APERTO, E CHE VA TENUTA CHIUSA ─────────────────────────────
  // `miniCiclo` adesso SCRIVE i tetti, quindi ogni test che lo guida senza iniettare `scriviTetti`
  // riscrive `data/maker-allocated-capital.json` VERO con i suoi mercati finti. È successo davvero
  // mentre si scriveva questo cambio: una suite ha lasciato il file di produzione con `0xaa/0xbb/0xcc`
  // e `capital: 600`, cioè NESSUN tetto per i mercati veri — che a valle vale «nessuna esposizione
  // nuova» su tutto. Il file è stato ripristinato; questa riga impedisce che riaccada in silenzio.
  const guidano = ['miniciclo-prende-il-mercato.test.js', 'passate-mini-ciclo.test.js'];
  for (const nome of guidano) {
    const src = fs.readFileSync(path.join(__dirname, nome), 'utf8');
    ok(`${nome} inietta i tetti invece di scrivere quelli veri`,
      /leggiTetti\s*:/.test(src) && /scriviTetti\s*:/.test(src));
  }

  // La selezione dei mercati non è stata toccata: questo cambio riguarda solo la persistenza.
  const t = fs.readFileSync(path.join(__dirname, 'trigger-capitale-fermo.js'), 'utf8');
  const dentroDecidiTetti = t.slice(t.indexOf('function decidiTetti('));
  ok('decidiTetti non sceglie mercati: non chiama né scegliMercato né pianificaGiro',
    !/scegliMercato\(|pianificaGiro\(/.test(dentroDecidiTetti));
  ok('  e non tocca il disco', !/require\('fs'\)|readFileSync|writeFileSync/.test(dentroDecidiTetti));
}

// ══ 7 · IL MINI-CICLO VERO, DAL VIVO ════════════════════════════════════════════════════════════════
// Le sezioni sopra provano la REGOLA. Questa prova che il mini-ciclo la USA: gira `miniCiclo` per
// davvero, con solo la corsia verso il venue e le scritture di stato sostituite da registratori.
const A = require(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler'));

function riga(id, capital) {
  return { marketId: id, name: `mercato ${id.slice(0, 8)}`, mid: 0.158, tick: 0.001, maxSpreadCents: 4.5,
    computedDefaultOffsetTicks: 1, capital, sizePerSideShares: 120.2, pairCostUsd: 1, minSizeShares: 5,
    realisticBestPerDay: 1.3, rif: { scoringMid: 0.158, bestBid: 0.157, bestAsk: 0.16 } };
}

// Lo stato del venue del 9 agosto, in piccolo: un ordine a riposo su Londra-19 e una posizione aperta
// su Pollnow. Servono a esercitare l'unione VERA — senza denaro da nessuna parte la potatura porterebbe
// via tutto, che è corretto ma non è il caso interessante.
const ORDINI = [{ marketId: LONDRA19, price: 0.4, size: 52.9 }];
const POSIZIONI = [{ conditionId: POLLNOW, size: 30, avgPrice: 0.72 }];

async function giroVero({ righe, snapshot, scrivi, saldoUsd = 606.28, ordini = ORDINI, posizioni = POSIZIONI, posLeggibili = true }) {
  const scritture = [];
  const r = await A.miniCiclo({ saldoUsd, forzato: true }, {
    // ⚠ LA SELEZIONE SI INIETTA, o `righeAmmesse` legge `data/selezione-mercati.json` VERO e toglie
    // tutte le righe di questo test perche' i suoi mercati non sono quelli che il bot ha scelto oggi.
    // Un test che dipende dalla selezione viva e' verde o rosso a seconda di cosa ha scelto il bot.
    selezione: () => ({ attiva: false, ids: [], idsAttivi: [] }),
    leggiPiano: () => ({ ok: false, motivo: 'nessun piano salvato' }),
    pianoLeggero: async () => ({ rows: righe }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    etaBoardMs: 60_000,
    diag: { readable: true, openNotionalUsd: 0 },
    leggiPosizioni: () => (posLeggibili
      ? { readable: true, ageMs: 0, positions: posizioni }
      : { readable: false, positions: [], ageMs: null, reason: 'snapshot delle posizioni non leggibile (mai scritto)' }),
    registraMercatoAperto: () => ({ ok: true, giaPresente: false }),
    setEnabled: () => ({ ok: true }), setManual: () => ({ ok: true }), setAutoClose: () => ({ ok: true }),
    leggiTetti: () => snapshot,
    scriviTetti: scrivi || ((a) => { scritture.push(a); return { ok: true, marketCount: a.rows.length }; }),
    piazza: async (rows) => ({ ok: true, placed: rows.length, refused: 0, skipped: 0,
      results: rows.map((x) => ({ ...x, esito: 'TEST — non inviato' })) }),
  });
  return { r, scritture };
}

(async () => {
  console.log('\n── 7 · IL MINI-CICLO VERO SCRIVE I TETTI PRIMA DI PIAZZARE');
  {
    const { r, scritture } = await giroVero({ righe: [riga(DALLAS, 120)], snapshot: fotografia0342() });
    ok('il giro alloca', r.esito === 'allocato', r.esito + (r.motivo ? ` — ${r.motivo}` : ''));
    ok('  e ha scritto i tetti', scritture.length === 1 && r.tetti && r.tetti.scritti === true,
      JSON.stringify(r.tetti || null).slice(0, 130));
    const ids = scritture.length ? scritture[0].rows.map((x) => x.marketId) : [];
    ok('  Dallas ha finalmente un tetto', ids.includes(DALLAS));
    // L'unione vera: il mercato del piano PIÙ quelli dove c'è del nostro denaro. Gli altri dieci del
    // piano vecchio non hanno né ordini né posizioni, quindi escono — è la potatura, non una perdita.
    ok('  il mercato con un ordine a riposo conserva il suo', ids.includes(LONDRA19), JSON.stringify(ids.map((x) => x.slice(0, 8))));
    ok('  e quello con una posizione aperta pure', ids.includes(POLLNOW));
    ok('  i dieci vuoti del piano vecchio escono', ids.length === 3, `${ids.length} mercati`);
    ok('  il capitale registrato è quello vero, non $600',
      scritture.length > 0 && scritture[0].capital > 600, `$${scritture.length ? scritture[0].capital : '?'}`);
    ok('  con la provenienza del trigger', scritture.length > 0 && /trigger capitale fermo/.test(scritture[0].by));
  }

  {
    // E se le posizioni non si leggono, NON si pota: un mercato con una posizione viva che perdesse il
    // tetto resterebbe ingestibile, e «non ho potuto guardare» non è «non c'è niente».
    const { scritture } = await giroVero({
      righe: [riga(DALLAS, 120)], snapshot: fotografia0342(), posLeggibili: false,
    });
    const n = scritture.length ? scritture[0].rows.length : 0;
    ok('posizioni illeggibili ⇒ non si pota niente', n === 13, `${n} mercati`);
  }

  {
    // Il giro dopo, contro la fotografia che il giro prima ha prodotto: non deve riscrivere.
    const { scritture: s1 } = await giroVero({ righe: [riga(DALLAS, 120)], snapshot: fotografia0342() });
    const prodotta = {
      readable: true, error: null, updatedAt: Date.now(), ageSec: 0, capital: s1[0].capital,
      markets: Object.fromEntries(s1[0].rows.map((x) => [x.marketId, { capitalUsd: x.capital }])),
    };
    const { r, scritture } = await giroVero({ righe: [riga(DALLAS, 120)], snapshot: prodotta });
    ok('il giro successivo NON riscrive', scritture.length === 0 && r.tetti && r.tetti.scritti === false, r.tetti && r.tetti.motivo);
    ok('  ma il giro procede lo stesso', r.esito === 'allocato', r.esito);
  }

  {
    // Una scrittura che esplode non deve fermare il capitale.
    const { r } = await giroVero({
      righe: [riga(DALLAS, 120)], snapshot: fotografia0342(),
      scrivi: () => { throw new Error('disco pieno'); },
    });
    ok('una scrittura dei tetti che fallisce NON ferma il giro', r.esito === 'allocato', r.esito);
    ok('  e il referto lo dichiara invece di tacere', r.tetti && /disco pieno/.test(r.tetti.motivo), r.tetti && r.tetti.motivo);
  }

  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nROSSI: il test stesso e' esploso — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

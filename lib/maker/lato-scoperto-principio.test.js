'use strict';
// lib/maker/lato-scoperto-principio.test.js — UN LATO SCOPERTO SI GESTISCE SEMPRE ALLO STESSO MODO.
//
// ═══ LA REGOLA GENERALE (operatore, 9 agosto 2026) ══════════════════════════════════════════════════
// Ogni volta che il bot rileva un lato posseduto senza controparte — QUALUNQUE sia la causa — deve:
//   1. riposizionare il lato posseduto a +1% dal carico, dentro banda, mai sotto il carico;
//   2. aprire contestualmente il limit uguale e contrario sulla controparte mancante;
//   3. e se la quantità è sotto il minimo piazzabile, ACCUMULARLA in un registro per mercato/lato
//      invece di lasciarla bloccata e silenziosa.
// I punti 1 e 2 sono `chiusura-rapida.pianificaRiposizionamentoScoperto`; il 3 è `accumulo-residui`.
//
// ═══ IL MINIMO È DEL VENUE, E NON È 20 ══════════════════════════════════════════════════════════════
// Misurato sul board vivo del 9 agosto (108 mercati): `min_incentive_size` vale 20 su 65 mercati, 50 su
// 26, 100 su 4, 200 su 13. Arriva dal catalogo premi del venue (`rewardsMinSize`), non è una costante
// nostra. Nel senso stretto di Polymarket significa «sotto questa size non maturi reward»
// (`venue-rules.js:86`: *earns nothing*), ma nel nostro stack `BELOW_MIN_SIZE` è BLOCCANTE — solo
// `OUT_OF_BAND` viene declassato ad avviso. Questo test prende quel vincolo come dato e verifica che la
// quantità non piazzabile non sparisca.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · il caso Dallas: residuo sotto soglia dopo merge parziale ⇒ accumulato, non muto
//   2 · due residui sullo stesso mercato/lato che sommati superano la soglia ⇒ uniti e piazzabili
//   3 · lo STESSO meccanismo per un fill scoperto normale, senza merge: è un principio, non una toppa
//   4 · un solo punto di convergenza in auto-close, e i vincoli duri intatti
//   5 · il ciclo di vita del registro: chiusura, potatura, persistenza

const fs = require('fs');
const os = require('os');
const path = require('path');
const AR = require('./accumulo-residui');
const CR = require('./chiusura-rapida');
const AC = require('./auto-close');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const DALLAS = '0xa7245f903c604b2a0ddbd9a454600395d06e0e2d4f28f8fe227fffdbb923a1c1';
const LONDRA = '0xc00c23bbbe2414e8d79516455d62ecd7088297d7bb9328d7b83d14f776e5c08f';
const T0 = 1_786_260_000_000;
const vuoto = () => ({ at: null, residui: {} });

// ══ 1 · IL CASO DALLAS: RESIDUO DI UN MERGE PARZIALE ═══════════════════════════════════════════════
console.log('── 1 · RESIDUO SOTTO SOGLIA DOPO UN MERGE PARZIALE: ACCUMULATO, NON MUTO');
{
  // Dallas il 9 agosto: NO 39,7 e YES 36,3. Il merge fonde il minimo (36,3) e lascia 3,4 NO scoperte.
  // Il minimo del venue per questo mercato è 20: il completamento non è piazzabile.
  const r = AR.registraResiduoScoperto({
    registro: vuoto(), marketId: DALLAS, book: 'no', sizeScoperta: 3.4, minSize: 20,
    causa: 'rinuncia · merge', prezzoCarico: 0.53, now: T0,
  });
  ok('il residuo viene registrato', r.ok === true && r.azione === 'accumulato', r.motivo);
  ok('  sotto la chiave mercato:lato', r.chiave === `${DALLAS}:no`, r.chiave);
  ok('  con la quantità vera', r.voce.size === 3.4, String(r.voce.size));
  ok('  e con quanto manca al minimo', r.voce.manca === 16.6, String(r.voce.manca));
  ok('  NON è ancora piazzabile', r.pronto === false);
  ok('  il capitale fermo è quantificato, non ignoto', r.voce.notionalUsd === 1.802, `$${r.voce.notionalUsd}`);
  ok('  e il motivo dice che sono accumulate, non perse', /accumulate, non perse/.test(r.motivo));
  // È esattamente ciò che prima non esisteva: il capitale fermo in residui si può SOMMARE.
  ok('il registro sa dire quanto capitale è fermo così', AR.capitaleFermoUsd(r.registro) === 1.802,
    `$${AR.capitaleFermoUsd(r.registro)}`);

  // Il vincolo duro resta: sotto il minimo NON si piazza. Il registro non è una scorciatoia.
  const rip = CR.pianificaRiposizionamentoScoperto({
    prezzoCarico: 0.53, sizePosseduta: 3.4, manca: 3.4, bandaHi: 0.56, tick: 0.01, minSize: 20,
  });
  ok('e il piazzamento resta rifiutato sotto il minimo', rip.ok === false, rip.motivo);
  ok('  per la size, non per un motivo inventato', /sotto il minimo del venue \(20\)/.test(rip.motivo));
}

// ══ 2 · DUE RESIDUI CHE SOMMATI SUPERANO LA SOGLIA ═════════════════════════════════════════════════
console.log('\n── 2 · DUE RESIDUI SULLO STESSO MERCATO/LATO: UNITI, E POI PIAZZABILI');
{
  // Primo residuo: 3,4 dal merge parziale.
  const uno = AR.registraResiduoScoperto({
    registro: vuoto(), marketId: DALLAS, book: 'no', sizeScoperta: 3.4, minSize: 20,
    causa: 'rinuncia · merge', prezzoCarico: 0.53, now: T0,
  });
  ok('primo residuo: 3,4 accumulate', uno.voce.size === 3.4 && uno.pronto === false);

  // Un secondo fill scopre altre 18,2 share sullo STESSO mercato/lato. L'osservazione successiva misura
  // l'intera quantità scoperta — 21,6 — perché è la posizione a contenerle entrambe.
  const due = AR.registraResiduoScoperto({
    registro: uno.registro, marketId: DALLAS, book: 'no', sizeScoperta: 21.6, minSize: 20,
    causa: 'rinuncia · maker-con-tetto', prezzoCarico: 0.53, now: T0 + 600_000,
  });
  ok('secondo residuo: il totale sale a 21,6', due.voce.size === 21.6, String(due.voce.size));
  ok('  e ORA supera il minimo del venue', due.pronto === true && due.azione === 'pronto', due.motivo);
  ok('  non manca più niente', due.voce.manca === 0, String(due.voce.manca));
  ok('  il registro lo elenca fra i pronti', AR.residuiPronti(due.registro).length === 1);
  ok('  e non conta più come capitale fermo', AR.capitaleFermoUsd(due.registro) === null);

  // LA STORIA È LEGGIBILE: si vede che è cresciuto, da dove, e quando. Una somma sola non lo direbbe.
  ok('la storia mostra ENTRAMBE le cause', due.voce.voci.length === 2
    && /merge/.test(due.voce.voci[0].causa) && /maker-con-tetto/.test(due.voce.voci[1].causa),
    JSON.stringify(due.voce.voci.map((v) => v.causa)));
  ok('  e conserva l\'istante del primo avvistamento', due.voce.primoAt === T0);

  // NON si sommano le OSSERVAZIONI: riosservare 21,6 non deve produrre 43,2.
  const tre = AR.registraResiduoScoperto({
    registro: due.registro, marketId: DALLAS, book: 'no', sizeScoperta: 21.6, minSize: 20,
    causa: 'rinuncia · maker-con-tetto', prezzoCarico: 0.53, now: T0 + 1_200_000,
  });
  ok('riosservare lo stesso scoperto NON lo raddoppia', tre.voce.size === 21.6, String(tre.voce.size));

  // E adesso il piazzamento passa davvero — stesso meccanismo, nessuna deroga.
  const rip = CR.pianificaRiposizionamentoScoperto({
    prezzoCarico: 0.53, sizePosseduta: 21.6, manca: 21.6, bandaHi: 0.56, tick: 0.01, minSize: 20,
  });
  ok('il meccanismo generale ora piazza', rip.ok === true, rip.motivo);
  ok('  il lato posseduto a +1% dal carico, dentro banda e sopra il carico',
    rip.latoPosseduto && rip.latoPosseduto.prezzo === 0.54 && rip.latoPosseduto.prezzo > 0.53);
  ok('  e la controparte uguale e contraria', rip.controparte && rip.controparte.size === 21.6);
}

// ══ 3 · LO STESSO MECCANISMO PER UN FILL SCOPERTO NORMALE ══════════════════════════════════════════
console.log('\n── 3 · UN FILL SCOPERTO SENZA NESSUN MERGE: STESSO PRINCIPIO, STESSO REGISTRO');
{
  // Londra 18°C: 23,15 NO comprate, zero YES. Nessun merge di mezzo — è il caso «fill originale», e il
  // minimo di QUESTO mercato è 50, non 20: la soglia è per mercato, non una costante.
  const r = AR.registraResiduoScoperto({
    registro: vuoto(), marketId: LONDRA, book: 'no', sizeScoperta: 23.15, minSize: 50,
    causa: 'rinuncia · maker-con-tetto', prezzoCarico: 0.65, now: T0,
  });
  ok('un fill scoperto entra nello STESSO registro', r.ok === true && r.azione === 'accumulato', r.motivo);
  ok('  con la soglia di QUESTO mercato (50), non una costante', r.voce.minSize === 50 && r.voce.manca === 26.85,
    `minSize ${r.voce.minSize}, mancano ${r.voce.manca}`);

  // Sopra la soglia del suo mercato lo stesso identico codice risponde «pronto»: nessun ramo speciale
  // per il merge, nessun ramo speciale per il fill.
  const sopra = AR.registraResiduoScoperto({
    registro: vuoto(), marketId: LONDRA, book: 'no', sizeScoperta: 60, minSize: 50,
    causa: 'rinuncia · fill', prezzoCarico: 0.65, now: T0,
  });
  ok('  e sopra la soglia risponde «pronto» senza rami speciali', sopra.pronto === true, sopra.motivo);

  // Due mercati diversi restano DUE residui: non si sommano fra mercati, e non si potrebbe — un ordine
  // vive su un mercato solo.
  const misto = AR.registraResiduoScoperto({
    registro: r.registro, marketId: DALLAS, book: 'no', sizeScoperta: 3.4, minSize: 20,
    causa: 'rinuncia · merge', prezzoCarico: 0.53, now: T0,
  });
  ok('mercati diversi restano residui distinti', Object.keys(misto.registro.residui).length === 2,
    Object.keys(misto.registro.residui).join(' | '));
  // Anche i due LATI dello stesso mercato sono due residui: sono due posizioni diverse.
  const dueLati = AR.registraResiduoScoperto({
    registro: misto.registro, marketId: DALLAS, book: 'yes', sizeScoperta: 5, minSize: 20,
    causa: 'rinuncia · fill', prezzoCarico: 0.47, now: T0,
  });
  ok('  e i due lati dello stesso mercato pure', Object.keys(dueLati.registro.residui).length === 3);
}

// ══ 4 · UN SOLO PUNTO DI CONVERGENZA, E I VINCOLI DURI INTATTI ═════════════════════════════════════
console.log('\n── 4 · UN PRINCIPIO, NON TRE TOPPE');
{
  const src = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const ag = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');

  // UNA funzione sola verso il registro, e le chiamate passano tutte da lì.
  ok('auto-close ha UN canale solo verso il registro',
    (src.match(/const segnalaScoperto = /g) || []).length === 1);
  // La definizione è `const segnalaScoperto = (…) =>`, che NON fa match su `segnalaScoperto(`:
  // ogni match è quindi una chiamata vera. Se ne pretendono almeno due — la coppia fusa e la rinuncia —
  // perché una sola vorrebbe dire che un esito terminale è tornato a essere muto.
  const chiamate = (src.match(/segnalaScoperto\(/g) || []).length;
  ok(`  usato da ${chiamate} esiti terminali, non sparso`, chiamate >= 2, `${chiamate} chiamate`);
  ok('  e la rinuncia — dove convergono TUTTI i modi di non aver coperto — è uno di quelli',
    /segnalaScoperto\(manca, `rinuncia/.test(src));
  ok('auto-close non conosce il file del registro: la scrittura vive in agent40',
    !/residui-scoperti|accumulo-residui/.test(src) && /accumulo-residui/.test(ag));
  ok('  e senza iniezione non succede niente (il registro non è un gate)',
    /typeof deps\.registraResiduo !== 'function'\) return/.test(src));
  ok('  un\'osservazione che fallisce non ferma la gestione della posizione',
    /catch \{ \/\* un'osservazione che non riesce/.test(src));

  // I VINCOLI DURI NON SONO STATI TOCCATI. È la parte che va provata, non affermata.
  const cr = fs.readFileSync(path.join(__dirname, 'chiusura-rapida.js'), 'utf8');
  ok('mai sotto il carico: il vincolo è ancora nel codice', /Non si vende in perdita per restare premiati/.test(cr));
  ok('  e la banda resta un tetto duro', /il prezzo calcolato uscirebbe dalla banda: non si propone/.test(cr));
  const mai = fs.readFileSync(path.join(__dirname, 'top-of-book.js'), 'utf8');
  ok('mai-primo-sul-libro non è stato toccato', mai.length > 0 && !/accumulo-residui|residuiPronti/.test(mai));
  ok('il registro non piazza e non cancella niente',
    !/placeOrder|cancelOrder|postOrder/.test(fs.readFileSync(path.join(__dirname, 'accumulo-residui.js'), 'utf8')));

  // Il modulo esistente `residui-sotto-soglia` è un'altra cosa e non è stato assorbito né duplicato.
  const vecchio = fs.readFileSync(path.join(__dirname, 'residui-sotto-soglia.js'), 'utf8');
  ok('`residui-sotto-soglia` resta separato, con la sua chiave orderId', /orderId/.test(vecchio));
  // Il confronto va fatto sul CODICE, non sul sorgente intero: l'intestazione del nuovo modulo cita
  // `orderId` proprio per spiegare che li' NON si usa, e cercarlo alla cieca farebbe cadere il test
  // sul commento che dice la cosa giusta.
  const nuovoCodice = fs.readFileSync(path.join(__dirname, 'accumulo-residui.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('  e il nuovo registro non indicizza per orderId', !/orderId/.test(nuovoCodice));
  ok('  la sua chiave è mercato:lato', AR.chiaveResiduo(DALLAS, 'no') === `${DALLAS}:no`
    && AR.chiaveResiduo(DALLAS, 'forse') === null);
}

// ══ 5 · IL CICLO DI VITA ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 5 · CHIUSURA, POTATURA, PERSISTENZA');
{
  const aperto = AR.registraResiduoScoperto({
    registro: vuoto(), marketId: DALLAS, book: 'no', sizeScoperta: 3.4, minSize: 20, now: T0,
  });
  // Lo scoperto rientra: la voce esce, senza bisogno di un percorso apposta.
  const chiuso = AR.registraResiduoScoperto({
    registro: aperto.registro, marketId: DALLAS, book: 'no', sizeScoperta: 0, minSize: 20, now: T0 + 1000,
  });
  ok('uno scoperto rientrato chiude la voce', chiuso.azione === 'chiuso' && Object.keys(chiuso.registro.residui).length === 0, chiuso.motivo);
  const negativo = AR.registraResiduoScoperto({
    registro: aperto.registro, marketId: DALLAS, book: 'no', sizeScoperta: -3.4, minSize: 20, now: T0 + 1000,
  });
  ok('  e anche uno scoperto negativo (l\'altro lato è più grande)', negativo.azione === 'chiuso');

  // Fail-closed sulle letture impossibili: non si inventa un residuo.
  for (const [nome, a] of [
    ['mercato assente', { marketId: null, book: 'no', sizeScoperta: 3 }],
    ['lato non valido', { marketId: DALLAS, book: 'forse', sizeScoperta: 3 }],
    ['quantità illeggibile', { marketId: DALLAS, book: 'no', sizeScoperta: NaN }],
  ]) {
    const r = AR.registraResiduoScoperto({ registro: vuoto(), minSize: 20, now: T0, ...a });
    ok(`${nome} ⇒ nessuna voce`, r.ok === false && r.azione === 'ignorato', r.motivo);
  }

  // Una posizione che non viene più osservata invecchia e se ne va.
  const { registro: potato, scadute } = AR.potaScadute(aperto.registro, T0 + 49 * 3_600_000);
  ok('una voce non più confermata da 49 h viene potata', scadute.length === 1 && Object.keys(potato.residui).length === 0);
  const { scadute: none } = AR.potaScadute(aperto.registro, T0 + 47 * 3_600_000);
  ok('  ma a 47 h è ancora lì: un residuo può aspettare giorni', none.length === 0);

  // Persistenza su un file vero, andata e ritorno.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'residui-'));
  const dep = { registroResiduiFile: path.join(dir, 'residui-scoperti.json') };
  ok('un registro mai scritto si legge come vuoto, non come errore',
    Object.keys(AR.leggiRegistroResidui(dep).residui).length === 0);
  const w = AR.scriviRegistroResidui(aperto.registro, dep);
  ok('la scrittura riesce', w.ok === true && w.count === 1);
  const riletto = AR.leggiRegistroResidui(dep);
  ok('  e il residuo si rilegge identico', riletto.residui[`${DALLAS}:no`].size === 3.4);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ══ 6 · IL CICLO VERO: completaCoppia CHIAMA IL REGISTRO ═══════════════════════════════════════════
(async () => {
  console.log('\n── 6 · IL CASO DALLAS ATTRAVERSO completaCoppia VERO');
  {
    const visti = [];
    const liv = { livello: 2, azione: 'maker-con-tetto', tetto: 0.46, size: 3.4, prezzo: null,
      numeri: { book: 'no', altroLato: 'yes', sizePosseduta: 39.7, sizeAltroLato: 36.3, mancaAllaCoppia: 3.4, tettoCents: 46 } };
    const r = await AC.completaCoppia({
      marketId: DALLAS, tok: 'tok', book: 'no',
      rules: { tick: 0.01, minSize: 20, maxSpreadCents: 4.5, negRisk: true,
        books: { yes: { scoringMid: 0.48 }, no: { scoringMid: 0.52 } } },
      liv, chiaveMerge: `${DALLAS}:tok`, reg: { leggi: () => null, segna: () => {}, pulisci: () => {} },
      prezzoCarico: 0.53, t0: T0,
      deps: {
        placeOrder: async () => ({ ok: false, gate: 'test', reason: 'TEST — non inviato' }),
        registraResiduo: (a) => { visti.push(a); return { ok: true }; },
      },
    });
    ok('completaCoppia rinuncia, come in produzione', r.esito === 'rinuncia', r.motivo);
    ok('  e SEGNALA il residuo invece di tacere', visti.length === 1, `${visti.length} segnalazioni`);
    ok('  con il lato posseduto', visti[0] && visti[0].book === 'no', visti[0] && visti[0].book);
    ok('  la quantità scoperta vera', visti[0] && visti[0].sizeScoperta === 3.4, String(visti[0] && visti[0].sizeScoperta));
    ok('  il minimo del venue di questo mercato', visti[0] && visti[0].minSize === 20);
    ok('  e la causa, così si sa da dove viene', visti[0] && /rinuncia/.test(visti[0].causa), visti[0] && visti[0].causa);

    // Senza iniezione il comportamento è identico a prima: il registro non è un gate.
    const senza = await AC.completaCoppia({
      marketId: DALLAS, tok: 'tok', book: 'no',
      rules: { tick: 0.01, minSize: 20, maxSpreadCents: 4.5, negRisk: true,
        books: { yes: { scoringMid: 0.48 }, no: { scoringMid: 0.52 } } },
      liv, chiaveMerge: `${DALLAS}:tok`, reg: { leggi: () => null, segna: () => {}, pulisci: () => {} },
      prezzoCarico: 0.53, t0: T0,
      deps: { placeOrder: async () => ({ ok: false, gate: 'test', reason: 'TEST' }) },
    });
    ok('senza il registro cablato il comportamento è identico', senza.esito === 'rinuncia');
  }

  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`\nROSSI: il test stesso e' esploso — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';
// UN MOTORE SOLO — LE CINQUE REGOLE, E NESSUNA BIFORCAZIONE.
//
// La proprietà che regge tutto: la Regola 4 non è una soglia NOSTRA, è `qMin` di lib/rewardScore.js —
// la stessa funzione che il board e agent24 usano per stimare i premi. Se un giorno il venue cambia la
// regola, cambia in un posto solo, e questo test lo verifica confrontando col modulo vero invece che
// con due numeri riscritti qui.

const {
  valutaMercato, controlloMaiPrimo, trovaLivello, pavimentoDepth, latoSingolo, tettoMercato,
  punteggioDiUnLivello,
  DEPTH_FLOOR_PCT_OF_AVG, DEPTH_FLOOR_FALLBACK_USD,
} = require('./motore-unico');
const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
const { qMin, C_FACTOR } = require('../rewardScore');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const TICK = 0.01;
const BANDA = { lo: 0.44, hi: 0.56 };
const MID = 0.50;
const RAGGIO = 6;   // ±6¢

console.log('\n══ LE COSTANTI: TRE NUMERI, NON DUE INSIEMI');
{
  ok('pavimento = 10% della liquidità media', DEPTH_FLOOR_PCT_OF_AVG === 0.10);
  ok('ripiego senza storico = $15', DEPTH_FLOOR_FALLBACK_USD === 15);
  // ── IL TETTO NON È PIÙ UNA COSTANTE DI QUESTO MODULO (9 agosto 2026) ───────────────────────────
  // Prima qui si asseriva `MARKET_CAP_PCT === 0.20`, cioè che il motore avesse la SUA copia del tetto
  // tenuta uguale a mano a quella del pianificatore. Adesso la copia non esiste: il motore importa il
  // numero dal modulo condiviso. L'asserzione difende quindi la proprietà nuova, che è più forte —
  // non «i due valori coincidono» ma «di valore ce n'è uno solo».
  ok('il tetto per mercato è FISSO e vale $130', MARKET_CAP_FIXED_USD === 130);
  ok('  il motore NON lo ridichiara: lo importa dal modulo condiviso',
    !/const\s+MARKET_CAP_(PCT|FIXED_USD)\s*=/.test(require('fs').readFileSync(require('path').join(__dirname, 'motore-unico.js'), 'utf8')));
  ok('  e non lo riesporta sotto un secondo nome',
    !Object.keys(require('./motore-unico')).some((k) => /MARKET_CAP/.test(k)),
    Object.keys(require('./motore-unico')).filter((k) => /^[A-Z_]+$/.test(k)).join(', '));
  const esportati = Object.keys(require('./motore-unico'));
  ok('nessuna costante «SAFE_» o «RISK_» sopravvive',
    !esportati.some((k) => /^SAFE_|^RISK_/.test(k)), esportati.filter((k) => /^[A-Z_]+$/.test(k)).join(', '));
}

console.log('\n══ REGOLA 2 · IL PAVIMENTO È RELATIVO AL MERCATO');
{
  // Mercato LIQUIDO: 94.931 share medie a 0,74 ⇒ media $70.249 ⇒ pavimento $7.024,89.
  const liquido = pavimentoDepth({ liquiditaMediaShare: 94931, prezzoRif: 0.74, campioni: 192 });
  ok('mercato liquido ⇒ pavimento ALTO in dollari', liquido.usd > 7000 && liquido.fonte === 'media', `$${liquido.usd}`);

  // Mercato SOTTILE: 300 share a 0,50 ⇒ media $150 ⇒ pavimento $15.
  const sottile = pavimentoDepth({ liquiditaMediaShare: 300, prezzoRif: 0.50, campioni: 50 });
  ok('mercato sottile ⇒ pavimento BASSO', Math.abs(sottile.usd - 15) < 1e-6, `$${sottile.usd}`);
  ok('  e i due differiscono di ordini di grandezza', liquido.usd / sottile.usd > 100,
    `${Math.round(liquido.usd / sottile.usd)}× — è esattamente ciò che una soglia fissa non poteva fare`);

  // Senza storico: ripiego, dichiarato.
  const nuovo = pavimentoDepth({ liquiditaMediaShare: null, prezzoRif: 0.5, campioni: 0 });
  ok('mercato nuovo ⇒ ripiego $15', nuovo.usd === 15 && nuovo.fonte === 'fallback', nuovo.motivo);
  const pochi = pavimentoDepth({ liquiditaMediaShare: 9999, prezzoRif: 0.5, campioni: 2 });
  ok('  storico troppo corto ⇒ ripiego, non una media su due punti', pochi.fonte === 'fallback', `${pochi.usd}`);
}

console.log('\n══ REGOLE 2+3 · SI FERMA AL PRIMO CHE BASTA (il quadratico è il motivo)');
{
  // Liv.1 (top) ignorato. Liv.2 49¢×40 = $19,60 ⇒ supera un pavimento da $15.
  // Liv.3 avrebbe $245: se cercasse il massimo, sceglierebbe quello e perderebbe punteggio.
  const r = trovaLivello({
    side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], pavimentoUsd: 15,
    scoringMid: MID, bandRadiusCents: RAGGIO,
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 40 }, { price: 0.48, size: 500 }],
  });
  ok('sceglie il SECONDO livello, non il terzo', r.ok && r.level === 2 && r.price === 0.49, `liv.${r.level}`);
  ok('  e il motivo dice perché non si cerca oltre', /rende di più/.test(r.motivo));

  // Il punteggio del livello scelto è più alto di quello del successivo: è la ragione della Regola 3.
  const s2 = punteggioDiUnLivello({ price: 0.49, scoringMid: MID, bandRadiusCents: RAGGIO });
  const s3 = punteggioDiUnLivello({ price: 0.48, scoringMid: MID, bandRadiusCents: RAGGIO });
  ok('  fermarsi prima rende di più: S(49¢) > S(48¢)', s2 > s3, `${s2} vs ${s3}`);
  ok('  e la differenza è QUADRATICA, non lineare',
    Math.abs(s2 - ((RAGGIO - 1) / RAGGIO) ** 2) < 1e-6, `S(1¢ dal mid) = ${s2}`);

  // Pavimento alto ⇒ si scende. Stesso book, pavimento $200.
  const alto = trovaLivello({
    side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], pavimentoUsd: 200,
    scoringMid: MID, bandRadiusCents: RAGGIO,
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 40 }, { price: 0.48, size: 500 }],
  });
  ok('pavimento più alto ⇒ livello più lontano', alto.ok && alto.level === 3, `liv.${alto.level}`);

  const esaurita = trovaLivello({
    side: 'BUY', tick: TICK, bandBounds: BANDA, ownOrders: [], pavimentoUsd: 99999,
    scoringMid: MID, bandRadiusCents: RAGGIO,
    bookLevels: [{ price: 0.50, size: 100 }, { price: 0.49, size: 40 }],
  });
  ok('banda esaurita prima del pavimento ⇒ skip', !esaurita.ok, esaurita.motivo);
}

console.log('\n══ REGOLA 4 · LA DECIDE LA FORMULA, NON UNA SOGLIA NOSTRA');
{
  // Il confronto che conta: il verdetto del motore DEVE coincidere con `qMin` del modulo canonico.
  for (const mid of [0.05, 0.0999, 0.10, 0.50, 0.90, 0.9001, 0.95]) {
    const v = latoSingolo({ mid, esisteGia: true });
    const atteso = qMin(1, 0, mid);
    ok(`mid ${mid}: frazione ${v.frazione} = qMin del modulo canonico`, v.frazione === atteso,
      `azione ${v.azione}`);
  }
  ok('dentro il range si TIENE', latoSingolo({ mid: 0.5, esisteGia: true }).azione === 'tieni');
  ok('  e la frazione è 1/' + C_FACTOR, Math.abs(latoSingolo({ mid: 0.5 }).frazione - 1 / C_FACTOR) < 1e-9);
  ok('fuori dal range si CANCELLA SUBITO', latoSingolo({ mid: 0.95, esisteGia: true }).azione === 'cancella');
  ok('  senza aspettare nessun timer', /senza aspettare nessun timer/.test(latoSingolo({ mid: 0.95 }).motivo));
  ok('fuori dal range NON si piazza un lato nuovo',
    latoSingolo({ mid: 0.95, esisteGia: false }).azione === 'non-piazzare');

  // Mid illeggibile: non si piazza, ma non si cancella nemmeno ciò che c'è già.
  const cieco = latoSingolo({ mid: null, esisteGia: true });
  ok('mid illeggibile ⇒ si tiene quello che c\'è', cieco.azione === 'tieni', cieco.motivo);
  ok('  ma non se ne piazza uno nuovo', latoSingolo({ mid: null, esisteGia: false }).azione === 'non-piazzare');
}

console.log('\n══ REGOLA 4 · IL CAMBIO DI RANGE FRA DUE CICLI È IMMEDIATO');
{
  // Stesso mercato, due letture consecutive del mid: il comportamento segue il mid del momento.
  const dentro = latoSingolo({ mid: 0.89, esisteGia: true });
  const fuori = latoSingolo({ mid: 0.91, esisteGia: true });
  const dentroDiNuovo = latoSingolo({ mid: 0.88, esisteGia: true });
  ok('0.89 → tieni · 0.91 → cancella · 0.88 → tieni',
    dentro.azione === 'tieni' && fuori.azione === 'cancella' && dentroDiNuovo.azione === 'tieni',
    `${dentro.azione} → ${fuori.azione} → ${dentroDiNuovo.azione}`);
  ok('  nessuno stato appiccicato dal giro precedente', dentroDiNuovo.frazione === dentro.frazione);
}

console.log('\n══ REGOLA 5 · UN SOLO TETTO, UGUALE PER TUTTI');
{
  // Il tetto e' FISSO a $130, quindi NON dipende piu' dal saldo: con $1000 in cassa vale $130, non $200.
  const dentro = tettoMercato({ saldoUsd: 1000, esposizioneMercatoUsd: 100, aggiuntaUsd: 29 });
  ok('$100 + $29 = $129 sotto $130 ⇒ consentito', dentro.consentito === true, `cap $${dentro.capUsd}`);
  const fuori = tettoMercato({ saldoUsd: 1000, esposizioneMercatoUsd: 100, aggiuntaUsd: 31 });
  ok('$131 ⇒ rifiutato', fuori.consentito === false, fuori.motivo);
  ok('  e il cap e $130 FISSO, non una frazione del saldo', dentro.capUsd === 130, `$${dentro.capUsd}`);
  ok('  lo stesso saldo raddoppiato NON alza il tetto',
    tettoMercato({ saldoUsd: 2000, aggiuntaUsd: 1 }).capUsd === 130);

  // ── IL TEST CHE PROTEGGE DAL RISCHIO CRITICO DEL 9 AGOSTO 2026 ─────────────────────────────────
  // Col tetto percentuale il pianificatore proponeva $130 e QUESTA regola verificava contro il 20% del
  // saldo — $118,82 sul saldo reale di quel giorno — rifiutando ogni riga del piano al quoting. Adesso
  // le due cose leggono lo stesso numero, e questa asserzione e' quella che se ne accorgerebbe.
  const { MARKET_CAP_FIXED_USD: TETTO } = require('../rewards/concentration');
  const rigaDelPiano = tettoMercato({ saldoUsd: 594.10, esposizioneMercatoUsd: 0, aggiuntaUsd: TETTO });
  ok('una riga del piano ESATTAMENTE al tetto passa la Regola 5 sul saldo vero',
    rigaDelPiano.consentito === true, rigaDelPiano.motivo);

  // ── IL CLAMP: il tetto puo' solo STRINGERE ────────────────────────────────────────────────────
  const povero = tettoMercato({ saldoUsd: 50, esposizioneMercatoUsd: 0, aggiuntaUsd: 60 });
  ok('con $50 in cassa il tetto scende a $50, non resta $130',
    povero.capUsd === 50 && povero.consentito === false, povero.motivo);

  const senzaSaldo = tettoMercato({ saldoUsd: null, aggiuntaUsd: 1 });
  ok('saldo non leggibile ⇒ nessuna nuova esposizione', senzaSaldo.consentito === false, senzaSaldo.motivo);
}

console.log('\n══ REGOLA 1 · VINCOLO ASSOLUTO, IN OGNI CASO');
{
  // Saremmo primi e un tick dietro esce dalla banda ⇒ si ferma qui, e NON si valuta altro.
  const r = valutaMercato({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, bandRadiusCents: RAGGIO, scoringMid: MID,
    bookLevels: [{ price: 0.50, size: 200 }, { price: 0.44, size: 100 }],
    ownOrders: [{ orderId: 'X', price: 0.50, size: 200 }],
    saldoUsd: 1000, proposedSize: 10, proposedPrice: 0.49,
  });
  ok('bocciato da mai-primo', !r.ok && r.bocciature[0].regola === 'mai-primo-sul-libro', r.motivo.slice(0, 70));
  ok('  ed è un\'uscita anticipata: gli altri controlli non girano',
    r.controlli.livello === undefined && r.controlli.tetto === undefined,
    'se non si piazza comunque, calcolare il resto è lavoro sprecato');

  // Nemmeno un pavimento generosissimo lo scavalca.
  const generoso = valutaMercato({
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, bandRadiusCents: RAGGIO, scoringMid: MID,
    bookLevels: [{ price: 0.50, size: 200 }, { price: 0.44, size: 999999 }],
    ownOrders: [{ orderId: 'X', price: 0.50, size: 200 }],
    saldoUsd: 1_000_000, proposedSize: 1, proposedPrice: 0.49,
  });
  ok('nemmeno con liquidità enorme e saldo enorme si passa', !generoso.ok,
    'la Regola 1 non si negozia contro il punteggio');
}

console.log('\n══ IL PERCORSO UNICO: TUTTE LE REGOLE, UNA VOLTA SOLA');
{
  const base = {
    marketId: 'M', side: 'BUY', tick: TICK, bandBounds: BANDA, bandRadiusCents: RAGGIO, scoringMid: MID,
    bookLevels: [{ price: 0.51, size: 500 }, { price: 0.50, size: 100 }, { price: 0.49, size: 500 }],
    ownOrders: [], saldoUsd: 1000, esposizioneMercatoUsd: 0, proposedSize: 10, proposedPrice: 0.49,
    liquiditaMediaShare: 300, liquiditaCampioni: 50,
  };
  const r = valutaMercato(base);
  ok('passa', r.ok === true, r.motivo.slice(0, 80));
  ok('  ed espone tutti e quattro i controlli valutati',
    !!r.controlli.maiPrimo && !!r.controlli.pavimento && !!r.controlli.livello && !!r.controlli.tetto,
    Object.keys(r.controlli).join(', '));
  ok('  col punteggio relativo del livello scelto', r.punteggioRelativo != null && r.punteggioRelativo > 0,
    `S = ${r.punteggioRelativo}`);

  // Il tetto boccia da solo.
  const oltre = valutaMercato({ ...base, esposizioneMercatoUsd: 199 });
  ok('il tetto boccia da solo', !oltre.ok && oltre.bocciature.some((b) => b.regola === 'tetto-mercato'));

  // Lato singolo fuori range ⇒ azione di cancellazione, prima ancora di cercare il livello.
  // La banda va spostata col mid: con mid 0.95 e la banda a [0.44, 0.56] cadrebbe prima la Regola 1,
  // e il test misurerebbe quella invece della 4.
  const soloFuori = valutaMercato({
    ...base, scoringMid: 0.95, bandBounds: { lo: 0.89, hi: 1.0 }, latiAttivi: ['no'],
    bookLevels: [{ price: 0.96, size: 500 }, { price: 0.95, size: 100 }, { price: 0.94, size: 500 }],
  });
  ok('lato singolo fuori range ⇒ azione «cancella»', soloFuori.azioneRichiesta === 'cancella', soloFuori.motivo.slice(0, 60));
  ok('  e dentro range invece si tiene (nessuna azione di cancellazione)',
    valutaMercato({ ...base, latiAttivi: ['no'] }).azioneRichiesta === undefined);

  // ── ownOrders ESCLUSI: si misura la CIFRA, non solo l'esito ─────────────────────────────────
  // Il libro pubblica 100 share a 50¢ (il 2° livello per un BUY con mid 0,50), ma 90 sono NOSTRE.
  // Senza l'esclusione la profondità al 2° livello sarebbe $50; con l'esclusione è $5.
  const senzaNostri = valutaMercato(base);
  const conNostri = valutaMercato({ ...base, ownOrders: [{ orderId: 'A', price: 0.50, size: 90 }] });
  // L'EFFETTO GIUSTO NON È «MENO DOLLARI», È «PIÙ IN BASSO». Togliendo la nostra size il 2° livello
  // si assottiglia ($50 → $5), non basta più il pavimento, e il motore scende al 3°. La cumulata di
  // conseguenza SALE. Averlo scritto al contrario la prima volta è il motivo per cui l'assert va sul
  // LIVELLO, che è la grandezza su cui la regola agisce, e non sulla somma.
  const lSenza = senzaNostri.controlli.livello.level;
  const lCon = conNostri.controlli.livello.level;
  ok('togliendo i nostri, il livello scelto è più lontano dal mid', lCon > lSenza, `liv.${lSenza} → liv.${lCon}`);
  ok('  e il prezzo scelto cambia di conseguenza',
    conNostri.price !== senzaNostri.price, `${senzaNostri.price} → ${conNostri.price}`);
  ok('  senza esclusione il 2° livello sarebbe bastato ($50 pubblicati)',
    Math.abs(senzaNostri.controlli.livello.depthAheadUsd - 50) < 1e-6,
    `$${senzaNostri.controlli.livello.depthAheadUsd} — di cui 90 share nostre nel caso con ownOrders`);
}

console.log('\n══ ISOLAMENTO E ASSENZA DI BIFORCAZIONI');
{
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./motore-unico'), 'utf8');
  const senzaCommenti = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('nessun ramo su un profilo', !/profilo|profile/i.test(senzaCommenti));
  ok('nessuno stato mutabile di modulo', !/^const \w+ = new (Map|Set)\(/m.test(src) && !/^let /m.test(src));
  ok('nessun fs, nessuna rete, nessun orologio', !/require\('fs'\)|fetch\(|Date\.now\(\)/.test(senzaCommenti));
  ok('la formula è IMPORTATA, non riscritta', /require\('\.\.\/rewardScore'\)/.test(src));
  ok('  e qMin non è reimplementato qui', !/function qMin/.test(src));

  // Due mercati alternati: nessuna interferenza.
  const arg = (liq) => ({
    marketId: 'X', side: 'BUY', tick: TICK, bandBounds: BANDA, bandRadiusCents: RAGGIO, scoringMid: MID,
    bookLevels: [{ price: 0.51, size: 500 }, { price: 0.50, size: 100 }, { price: 0.49, size: 500 }],
    ownOrders: [], saldoUsd: 1000, proposedSize: 10, proposedPrice: 0.49,
    liquiditaMediaShare: liq, liquiditaCampioni: 50,
  });
  const seq = [300, 999999, 300, 999999, 300].map((l) => valutaMercato(arg(l)).ok);
  ok('alternando due mercati il verdetto segue i loro dati',
    JSON.stringify(seq) === JSON.stringify([true, false, true, false, true]), seq.join(','));
}

console.log(`\nmotore unico: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

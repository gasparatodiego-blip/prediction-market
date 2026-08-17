'use strict';
// lib/maker/modalita-chiusura.test.js — IL FLUSSO DEL FILL, DAL TIMESTAMP ALLA RIPIANIFICAZIONE.
//
// Guida le funzioni VERE (`completaCoppia`, `pianificaRiposizionamentoScoperto`, `riposizionaDopoChiusura`)
// con la sola corsia di piazzamento sostituita da un registratore: nessun ordine parte, nessun file di
// produzione viene toccato — il registro della modalità chiusura è in memoria, non su disco.

const assert = require('assert');
const path = require('path');

const AC = require('./auto-close');
const MC = require('./modalita-chiusura');
const { pianificaRiposizionamentoScoperto } = require('./chiusura-rapida');
const { decidiLivello } = require('./strategia-merge');
const { FILL_PARZIALE, FILL_COMPLETO } = require('./risposta-al-fill');
const { raggioBandaCents } = require('../banda-premiante');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); fail++; }
};

// ── REGISTRO IN MEMORIA: la stessa interfaccia che agent40 implementa su disco ────────────────────
function registroFinto() {
  let reg = {};
  return {
    _dump: () => reg,
    leggi: (m, b) => MC.leggiChiusura(reg, m, b),
    entra: (a) => { const r = MC.entraInChiusura({ ...a, registro: reg }); reg = r.registro; return r; },
    attiva: (a) => { const r = MC.attivaRegole({ ...a, registro: reg }); reg = r.registro; return r; },
    esci: (a) => { const r = MC.esciDaChiusura({ ...a, registro: reg }); reg = r.registro; return r; },
  };
}

// Un mercato realistico: tick 1¢, banda 4,5¢, minimo 20 share.
function regoleFinte({ midYes = 0.40, maxSpreadCents = 4.5, minSize = 20 } = {}) {
  return {
    readable: true, marketId: '0xMKT', tick: 0.01, maxSpreadCents, minSize,
    tokenId: 'TOKY', tokenIdNo: 'TOKN', negRisk: false, mid: midYes,
    rewardProgramme: 'active', bandRadiusCents: raggioBandaCents(maxSpreadCents),
    books: {
      yes: { tokenId: 'TOKY', scoringMid: midYes, bestBid: midYes - 0.01, bestAsk: midYes + 0.01 },
      no: { tokenId: 'TOKN', scoringMid: +(1 - midYes).toFixed(6), bestBid: 0.58, bestAsk: 0.62 },
    },
  };
}

/** Costruisce il verdetto con la funzione VERA, così i numeri non sono inventati. */
function livelloVero({ sizePosseduta, sizeAltroLato, prezzoCarico, asksAltroLato = null }) {
  return decidiLivello({ book: 'yes', sizePosseduta, sizeAltroLato, prezzoCarico, asksAltroLato, now: 1786500000000 });
}

/** Esegue `completaCoppia` con un registratore al posto della corsia di piazzamento. */
async function giro({ liv, rules, ordiniMercato, chiusura, prezzoCarico, dpMerge = null,
  placeOk = () => false, cancelOk = true, scadenza = undefined }) {
  const piazzati = [], cancellati = [], auditRighe = [];
  const esito = await AC.completaCoppia({
    marketId: '0xMKT', tok: 'TOKY', book: 'yes', rules, liv, dpMerge,
    attesa: null, chiaveMerge: '0xMKT:TOKY',
    reg: { leggi: () => null, segna: () => {}, pulisci: () => {} },
    cancelOrderIds: [], prezzoCarico, ordiniMercato,
    deps: {
      chiusura,
      ...(scadenza === undefined ? {} : { scadenzaMercato: () => scadenza }),
      placeOrder: async (o) => { piazzati.push(o); const r = placeOk(o); return r === true ? { ok: true, orderId: 'O' + piazzati.length } : (r || { ok: false, gate: 'venue', reason: 'rifiutato dal fixture' }); },
      cancelOrder: async (o) => { cancellati.push(o.orderId); return { ok: cancelOk }; },
    },
    audit: (r) => auditRighe.push(r),
    t0: 1786500000000,
  });
  return { esito, piazzati, cancellati, auditRighe };
}

(async () => {
  console.log('\n════ 1 · FILL PARZIALE 40/100 ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    // 40 share di YES possedute a 40¢, nessuna copertura. L'ordine originale era 100 ⇒ 60 a riposo.
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40 });
    const ordini = [
      { orderId: 'RESIDUO', tokenId: 'TOKY', side: 'BUY', size: 100, sizeMatched: 40, sizeRemaining: 60 },
      { orderId: 'SORELLA', tokenId: 'TOKN', side: 'BUY', size: 100, sizeMatched: 0, sizeRemaining: 100 },
    ];
    const g = await giro({ liv, rules, ordiniMercato: ordini, chiusura, prezzoCarico: 0.40 });

    ok('il TIMESTAMP è registrato sulla coppia', chiusura.leggi('0xMKT', 'yes').attiva === true);
    ok('  ed è leggibile in ISO', /^\d{4}-\d{2}-\d{2}T/.test(chiusura.leggi('0xMKT', 'yes').daIso || ''));
    ok('  con la size fillata (40), non quella piazzata (100)',
      chiusura.leggi('0xMKT', 'yes').sizeFillata === 40);
    // ⚠ LE DUE DOMANDE SONO DIVERSE, e questo test le tiene separate apposta: `tipoFill` dice quanto
    // della POSIZIONE è coperto (qui: niente ⇒ `fill-completo`), `fillOrdine` dice quanto dell'ORDINE è
    // stato eseguito (qui: 40 su 100 ⇒ `parziale`). È quest'ultima che il requisito chiama «parziale».
    ok('  ed è marcato come ordine eseguito in PARTE (40 su 100)',
      chiusura.leggi('0xMKT', 'yes').fillOrdine === MC.FILL_ORDINE_PARZIALE,
      String(chiusura.leggi('0xMKT', 'yes').fillOrdine));
    ok('  mentre la COPERTURA è nulla, quindi `fill-completo` per classificaFill',
      chiusura.leggi('0xMKT', 'yes').tipoFill === FILL_COMPLETO);
    // ⚠ IL MOMENTO E' CAMBIATO IL 15 AGOSTO 2026, decisione dell'operatore: «posa subito la gamba
    // opposta della stessa quantita' riempita; quando anche quella si chiude, cancella il residuo
    // dell'ordine originale ancora a libro». Il residuo e' un ordine maker valido dentro banda che
    // MATURA PREMI, e buttarlo nell'istante del fill parziale regala reward per un rischio che non si
    // e' ancora materializzato. Resta a libro, e si cancella a COPPIA COMPLETA (blocco 1-bis).
    // ⚠ ROVESCIATA IL 17 AGOSTO 2026, su requisito dell'operatore: «residuo cancellato se parziale».
    // Il discriminante era `fill.tipo` (la COPERTURA) e adesso e' `resid.fillOrdine` (il fatto letto
    // DAL LIBRO: e' rimasto qualcosa a riposo sulla gamba riempita?). Qui la copertura e' nulla —
    // quindi `fill-completo` — ma l'ORDINE e' stato eseguito in parte, ed e' lo stato piu' esposto
    // che ci sia: la gamba e' nuda e un secondo riempimento la ingrossa mentre la si sta chiudendo.
    // Cio' a cui si rinuncia — che il residuo completi la coppia da solo — e' dichiarato nel codice.
    ok('le 60 share NON FILLATE escono dal libro: l\'ordine e stato eseguito in PARTE',
      g.cancellati.includes('RESIDUO'), g.cancellati.join(',') || 'nessuna cancellazione');
    ok('la sorella sovradimensionata è invece cancellata SUBITO: comprerebbe piu controparte del dovuto',
      g.cancellati.includes('SORELLA'));
    ok('  e il timestamp compare in audit', g.auditRighe.some((r) => r.outcome === 'modalita-chiusura-ingresso'));
    const sorella = g.piazzati.find((o) => o.book === 'no' && o.side === 'BUY');
    ok('la sorella viene ripiazzata a size ESATTAMENTE pari al fillato (40)',
      !!sorella && sorella.size === 40, sorella ? String(sorella.size) : 'nessuna');
    ok('  e NON alla size originale di 100', !sorella || sorella.size !== 100);

    // Idempotenza: il secondo giro non ricancella niente.
    const g2 = await giro({ liv, rules, ordiniMercato: ordini, chiusura, prezzoCarico: 0.40 });
    ok('al SECONDO giro non si ricancella nulla (nessuna churn)', g2.cancellati.length === 0,
      g2.cancellati.join(','));
    ok('  e il timestamp NON si sposta',
      chiusura.leggi('0xMKT', 'yes').daIso === chiusura.leggi('0xMKT', 'yes').daIso
      && chiusura._dump()['0xMKT:yes'].da === 1786500000000);
  }

  // ══ 1-bis · COPPIA COMPLETA ⇒ IL RESIDUO SPARISCE (15 agosto 2026) ═════════════════════════════
  // L'altra meta' della regola, e la piu' importante: «non deve restare una gamba scoperta». Finche'
  // la coppia non e' completa il residuo lavora; nell'istante in cui lo diventa, un suo fill
  // riaprirebbe esposizione direzionale, quindi va via.
  console.log('\n════ 1-bis · COPPIA COMPLETA: IL RESIDUO VIENE CANCELLATO ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    // 40 YES possedute, 40 NO gia' in casa ⇒ `manca <= 0`, la coppia e' completa. L'ordine originale
    // ha ancora 60 share a riposo sulla gamba riempita.
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 40, prezzoCarico: 0.40 });
    const ordini = [{ orderId: 'RESIDUO', tokenId: 'TOKY', side: 'BUY', size: 100, sizeMatched: 40, sizeRemaining: 60 }];
    const g = await giro({ liv, rules, ordiniMercato: ordini, chiusura, prezzoCarico: 0.40 });
    ok('a coppia completa il residuo della gamba riempita viene cancellato',
      g.cancellati.includes('RESIDUO'), g.cancellati.join(',') || 'nessuna');
    ok('  e il motivo finisce a verbale con un esito suo, distinguibile',
      g.auditRighe.some((r) => r.outcome === 'coppia-completa-residuo-cancellato'));

    // IDEMPOTENZA PER COSTRUZIONE: cancellato l'ordine, il libro non lo porta piu' e il giro dopo la
    // lista esce vuota da sola — nessun flag da ricordare.
    const g2 = await giro({ liv, rules, ordiniMercato: [], chiusura, prezzoCarico: 0.40 });
    ok('  e il giro dopo non c\'e\' piu\' niente da cancellare', g2.cancellati.length === 0, g2.cancellati.join(','));

    // ⚠ QUESTA ASSERZIONE DICEVA IL CONTRARIO, E LA REGOLA E' STATA ROVESCIATA IL 16 AGOSTO 2026
    // (`43523d9`, «fill parziale: il residuo si cancella subito, come nel totale»). Il commit ha
    // cambiato `auto-close.js` e non ha toccato questo test, che e' rimasto rosso a fotografare la
    // regola di prima. Qui si asserisce cio' che il codice FA, con accanto la ragione per cui lo fa.
    //
    // ⚠⚠ E VA DETTA UNA COSA CHE IL NOME NASCONDE, perche' il prossimo che legge non ci ricada:
    // in `classificaFill` «parziale» e «completo» descrivono la COPERTURA, non l'ordine.
    //     40 possedute / 0 coperte  ⇒ `fill-completo`  (manca 40: TOTALMENTE scoperta)
    //     40 possedute / 25 coperte ⇒ `fill-parziale`  (manca 15: parzialmente coperta)
    // Il ramo di `auto-close` cancella il residuo **solo** su `fill-parziale`. Quindi oggi il residuo
    // muore nello stato MENO esposto e SOPRAVVIVE in quello PIU' esposto — l'opposto dell'argomento
    // di pericolo scritto nel commit. Il blocco 1 di questo file lo mostra: 40/0 con 60 share a
    // riposo, e quelle 60 restano. Non e' un difetto che si corregge dentro un test: e' una
    // decisione di rischio, segnata in APERTI.md e da prendere con l'operatore.
    const chiusura2 = registroFinto();
    const livParziale = livelloVero({ sizePosseduta: 40, sizeAltroLato: 25, prezzoCarico: 0.40 });
    const g3 = await giro({ liv: livParziale, rules, ordiniMercato: ordini, chiusura: chiusura2, prezzoCarico: 0.40 });
    ok('con la coppia coperta SOLO IN PARTE il residuo si cancella all\'ingresso (regola del 16/08)',
      g3.cancellati.includes('RESIDUO'), g3.cancellati.join(',') || 'nessuna');
    ok('  e l\'esito lo dichiara come cancellazione d\'ingresso, non come «coppia completa»',
      g3.auditRighe.some((r) => r.outcome === 'modalita-chiusura-residuo-non-fillato-cancellato')
      && !g3.auditRighe.some((r) => r.outcome === 'coppia-completa-residuo-cancellato'),
      g3.auditRighe.map((r) => r.outcome).join(','));
  }

  console.log('\n════ 2 · LA SORELLA È ESENTE DA «MAI PRIMO», E SOLO LEI ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40 });
    const g = await giro({ liv, rules, ordiniMercato: [], chiusura, prezzoCarico: 0.40, placeOk: () => true });
    const sorella = g.piazzati.find((o) => o.book === 'no' && o.side === 'BUY' && !o.attraversaApposta);
    ok('la sorella si piazza', !!sorella);
    ok('  ed è ESENTE da «mai primo» (inCoda non dichiarato)',
      !!sorella && sorella.inCoda === undefined, sorella ? String(sorella.inCoda) : '-');
    const posseduta = g.piazzati.find((o) => o.book === 'yes' && o.side === 'SELL');
    ok('la gamba FILLATA viene piazzata nello stesso giro', !!posseduta);
    ok('  e NON è esente: dichiara inCoda:true, perché è un ordine che aspetta e matura premi',
      !!posseduta && posseduta.inCoda === true);
    ok('le regole di chiusura risultano attive nel registro',
      chiusura.leggi('0xMKT', 'yes').regoleAttive === true);
    ok('  e l\'attivazione è a verbale', g.auditRighe.some((r) => r.outcome === 'modalita-chiusura-regole-attive'));
  }

  console.log('\n════ 2-bis · LE REGOLE SI APRONO SOLO DOPO IL TENTATIVO IMMEDIATO ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    // Ask dell'altro lato abbondante e a buon mercato ⇒ decidiLivello risponde LIVELLO 1 (taker).
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40,
      asksAltroLato: [{ price: 0.55, size: 100 }] });
    ok('con l\'ask conveniente il verdetto è il Livello 1 (taker immediato)', liv.livello === 1, String(liv.livello));
    // Il taker RIESCE: la modalità chiusura non deve mai attivare le sue regole.
    const g = await giro({ liv, rules, ordiniMercato: [], chiusura, prezzoCarico: 0.40,
      placeOk: (o) => o.attraversaApposta === true });
    ok('il taker immediato viene tentato per primo',
      g.piazzati.length > 0 && g.piazzati[0].attraversaApposta === true);
    ok('  per size pari al fillato', g.piazzati[0].size === 40);
    ok('il timestamp c\'è comunque (fase 1)', chiusura.leggi('0xMKT', 'yes').attiva === true);
    ok('ma le REGOLE di chiusura restano SPENTE quando il taker riesce',
      chiusura.leggi('0xMKT', 'yes').regoleAttive === false);
    ok('  e nessuna gamba è stata piazzata in esenzione da «mai primo»',
      g.piazzati.filter((o) => !o.attraversaApposta && o.inCoda === undefined).length === 0);

    // Ora il taker FALLISCE: solo allora le regole si aprono.
    const chiusura2 = registroFinto();
    const g2 = await giro({ liv, rules, ordiniMercato: [], chiusura: chiusura2, prezzoCarico: 0.40,
      placeOk: (o) => o.attraversaApposta !== true });
    ok('taker rifiutato ⇒ ALLORA le regole si attivano', chiusura2.leggi('0xMKT', 'yes').regoleAttive === true);
    ok('  e la sorella maker parte esente', g2.piazzati.some((o) => !o.attraversaApposta && o.inCoda === undefined));
  }

  console.log('\n════ 3 · GAMBA FILLATA, MERCATO FAVOREVOLE ⇒ DENTRO BANDA ════');
  {
    // Carico 40¢, mid 41¢, banda ±2,25¢ ⇒ tetto banda 43,25¢. +1% dal carico = 40,4¢ → 41¢: dentro.
    const p = pianificaRiposizionamentoScoperto({
      prezzoCarico: 0.40, sizePosseduta: 40, manca: 40, bandaHi: 0.4325,
      tick: 0.01, minSize: 20, modalitaChiusura: true,
    });
    ok('il lato posseduto viene proposto', !!p.latoPosseduto, p.motivo);
    ok('  dentro la banda premiante', p.latoPosseduto.prezzo <= 0.4325 + 1e-9, String(p.latoPosseduto.prezzo));
    ok('  e sopra il carico', p.latoPosseduto.prezzo > 0.40, String(p.latoPosseduto.prezzo));
    ok('  e NON è marcato fuori banda', p.latoPosseduto.fuoriBanda !== true);
  }

  console.log('\n════ 4 · GAMBA FILLATA, MERCATO CONTRARIO ⇒ +1 TICK FUORI BANDA ════');
  {
    // Carico 65¢, mid sceso: banda fino a 63¢, cioè TUTTA sotto il carico.
    const p = pianificaRiposizionamentoScoperto({
      prezzoCarico: 0.65, sizePosseduta: 40, manca: 40, bandaHi: 0.63,
      tick: 0.01, minSize: 20, modalitaChiusura: true,
    });
    ok('il lato posseduto viene proposto COMUNQUE (prima taceva)', !!p.latoPosseduto, p.motivo);
    ok('  a carico + 1 tick = 66¢', !!p.latoPosseduto && p.latoPosseduto.prezzo === 0.66,
      p.latoPosseduto ? String(p.latoPosseduto.prezzo) : '-');
    ok('  ed è dichiarato FUORI banda', !!p.latoPosseduto && p.latoPosseduto.fuoriBanda === true);
    ok('  MAI sotto il costo di carico', !!p.latoPosseduto && p.latoPosseduto.prezzo > 0.65);
    ok('  e il motivo lo spiega', /fuori banda|FUORI banda/i.test(p.latoPossedutoMotivo || ''));

    // FUORI dalla modalità chiusura il comportamento è quello di prima: si tace.
    const q = pianificaRiposizionamentoScoperto({
      prezzoCarico: 0.65, sizePosseduta: 40, manca: 40, bandaHi: 0.63, tick: 0.01, minSize: 20,
    });
    ok('fuori dalla modalità chiusura resta il comportamento di prima (muto)', q.latoPosseduto === null);

    // ── SWEEP: nessun prezzo sotto il carico, in nessuna combinazione ──
    let sotto = 0, proposti = 0;
    for (const carico of [0.05, 0.20, 0.40, 0.61, 0.65, 0.80, 0.95]) {
      for (const bandaHi of [0.02, 0.10, 0.30, 0.50, 0.63, 0.90, 0.99]) {
        for (const tick of [0.001, 0.01, 0.1]) {
          const r = pianificaRiposizionamentoScoperto({
            prezzoCarico: carico, sizePosseduta: 40, manca: 40, bandaHi, tick, minSize: 20,
            modalitaChiusura: true,
          });
          if (r.latoPosseduto) { proposti++; if (r.latoPosseduto.prezzo <= carico + 1e-9) sotto++; }
        }
      }
    }
    ok(`sweep su 147 combinazioni: ${proposti} proposte, ZERO sotto il carico`, sotto === 0, `sotto=${sotto}`);
  }

  console.log('\n════ 5 · DOPO LA CHIUSURA, MERCATO ANCORA VALIDO ⇒ RIPIANIFICA DA ZERO ════');
  {
    const rules = regoleFinte();
    rules.books.yes.bestBid = 0.40; rules.books.no.bestBid = 0.58;
    const piazzati = [];
    const r = await AC.riposizionaDopoChiusura({
      marketId: '0xMKT', rules, capitaleUsd: 65, t0: 1786500000000,
      deps: { placeOrder: async (o) => { piazzati.push(o); return { ok: true, orderId: 'N' + piazzati.length }; } },
      audit: () => {},
    });
    ok('ripianifica', r.ok === true, r.motivo);
    ok('  DUE gambe nuove, una per lato', piazzati.length === 2
      && piazzati.some((o) => o.book === 'yes') && piazzati.some((o) => o.book === 'no'));
    ok('  entrambe in ACQUISTO, come un mercato appena entrato nel piano',
      piazzati.every((o) => o.side === 'BUY'));
    ok('  «MAI PRIMO» È DI NUOVO ATTIVO su entrambe (inCoda:true)',
      piazzati.every((o) => o.inCoda === true));
    ok('  un tick DIETRO il miglior bid, non davanti',
      piazzati.find((o) => o.book === 'yes').price === 0.39);
    ok('  e la size viene dal capitale del tetto corrente, diviso fra i due lati',
      Math.abs(piazzati.find((o) => o.book === 'yes').size - (65 / 2 / 0.39)) < 0.02);
    const val = MC.validoPerRipianificare({ rules, scadenzaMs: 1786500000000 + 72 * 3600000, ora: 1786500000000 });
    ok('  e il mercato è giudicato valido dalla stessa funzione che il ciclo usa', val.valido === true);
  }

  console.log('\n════ 6 · DOPO LA CHIUSURA, MERCATO NON PIÙ VALIDO ⇒ NIENTE ════');
  {
    const rules = regoleFinte();
    const ora = 1786500000000;
    ok('orizzonte sotto le 24h ⇒ non si ripianifica',
      MC.validoPerRipianificare({ rules, scadenzaMs: ora + 2 * 3600000, ora }).valido === false);
    ok('programma reward finito ⇒ non si ripianifica',
      MC.validoPerRipianificare({ rules: { ...rules, rewardProgramme: 'none' }, ora }).valido === false);
    ok('banda sparita ⇒ non si ripianifica',
      MC.validoPerRipianificare({ rules: { ...rules, maxSpreadCents: null }, ora }).valido === false);
    ok('regole non leggibili ⇒ non si ripianifica',
      MC.validoPerRipianificare({ rules: { ...rules, readable: false }, ora }).valido === false);
    ok('scadenza cercata e non trovata ⇒ non si ripianifica (fail-closed)',
      MC.validoPerRipianificare({ rules, scadenzaMs: null, ora }).valido === false);
    // E la prova che nessun ordine parte: `riposizionaDopoChiusura` su regole illeggibili.
    const piazzati = [];
    const r = await AC.riposizionaDopoChiusura({
      marketId: '0xMKT', rules: { readable: false }, capitaleUsd: 65,
      deps: { placeOrder: async (o) => { piazzati.push(o); return { ok: true }; } }, audit: () => {},
    });
    ok('  e nessun ordine viene piazzato', r.ok === false && piazzati.length === 0);
  }

  console.log('\n════ 7 · «MAI PRIMO» RESTA ASSOLUTO FUORI DALLA MODALITÀ CHIUSURA ════');
  {
    // Una chiusura in corso su un mercato NON deve toccare le regole di un altro.
    const chiusura = registroFinto();
    chiusura.entra({ marketId: '0xMKT', book: 'yes', tipoFill: FILL_PARZIALE, sizeFillata: 40, ora: 1 });
    chiusura.attiva({ marketId: '0xMKT', book: 'yes', motivo: 'test', ora: 2 });
    ok('il mercato in chiusura ha le regole attive', chiusura.leggi('0xMKT', 'yes').regoleAttive === true);
    ok('un ALTRO mercato non è in chiusura', chiusura.leggi('0xALTRO', 'yes').regoleAttive === false);
    ok('  e nemmeno l\'ALTRO LATO dello stesso mercato', chiusura.leggi('0xMKT', 'no').regoleAttive === false);

    // Il riposizionamento dopo chiusura — che gira mentre altre coppie possono essere in chiusura —
    // piazza sempre con inCoda:true.
    const rules = regoleFinte();
    const piazzati = [];
    await AC.riposizionaDopoChiusura({ marketId: '0xALTRO', rules, capitaleUsd: 65,
      deps: { placeOrder: async (o) => { piazzati.push(o); return { ok: true, orderId: 'X' }; } }, audit: () => {} });
    ok('il riposizionamento su un altro mercato dichiara inCoda:true',
      piazzati.length === 2 && piazzati.every((o) => o.inCoda === true));

    // ── PROVA STRUTTURALE: l'esenzione è UNA sola omissione condizionata, e nessun altro file l'ha
    //    imparata. `inCoda` è opt-in, quindi la regola in `manual-order` non è stata toccata.
    const fs = require('fs');
    const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    const omissioni = (ac.match(/regoleAttive \? \{\} : \{ inCoda: true \}/g) || []).length;
    ok('in auto-close l\'esenzione da modalità chiusura è UNA sola, e condizionata', omissioni === 1,
      String(omissioni));
    ok('  e `inCoda: true` resta dichiarato su molte altre gambe dello stesso file',
      (ac.match(/inCoda: true/g) || []).length >= 6, String((ac.match(/inCoda: true/g) || []).length));
    const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
    ok('la REGOLA in manual-order non è stata toccata: resta opt-in su spec.inCoda',
      /if \(spec\.inCoda === true\)/.test(mo));
    ok('  e manual-order non sa nemmeno che la modalità chiusura esista',
      !/modalita-chiusura|modalitaChiusura/.test(mo));
    const cr = fs.readFileSync(path.join(__dirname, 'chiusura-rapida.js'), 'utf8');
    ok('in chiusura-rapida il flag è FALSO di difetto', /modalitaChiusura = false/.test(cr));
  }

  console.log('\n════ 8 · FILL TOTALE 100/100 ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    // 100 share possedute, nessuna copertura, e sulla gamba riempita NESSUN ordine a riposo.
    const liv = livelloVero({ sizePosseduta: 100, sizeAltroLato: 0, prezzoCarico: 0.40 });
    const ordini = [{ orderId: 'SORELLA', tokenId: 'TOKN', side: 'BUY', size: 100, sizeMatched: 0, sizeRemaining: 100 }];
    const g = await giro({ liv, rules, ordiniMercato: ordini, chiusura, prezzoCarico: 0.40, placeOk: () => true });

    ok('entra in modalità chiusura come il parziale', chiusura.leggi('0xMKT', 'yes').attiva === true);
    ok('  ed è marcato come ordine eseguito per INTERO',
      chiusura.leggi('0xMKT', 'yes').fillOrdine === MC.FILL_ORDINE_TOTALE,
      String(chiusura.leggi('0xMKT', 'yes').fillOrdine));
    ok('  cioè l\'etichetta è DIVERSA da quella del caso 40/100, a parità di copertura nulla',
      chiusura.leggi('0xMKT', 'yes').tipoFill === FILL_COMPLETO
      && chiusura.leggi('0xMKT', 'yes').fillOrdine !== MC.FILL_ORDINE_PARZIALE);
    ok('  col timestamp registrato', typeof chiusura.leggi('0xMKT', 'yes').daIso === 'string');
    ok('NESSUNA cancellazione inutile sulla gamba riempita: non c\'era residuo',
      !g.cancellati.includes('RESIDUO'));
    ok('  si cancella SOLO la sorella, che va ridimensionata', g.cancellati.length === 1
      && g.cancellati[0] === 'SORELLA', g.cancellati.join(','));
    const sorella = g.piazzati.find((o) => o.book === 'no' && o.side === 'BUY' && !o.attraversaApposta);
    ok('la sorella è portata alla size fillata (100, cioè l\'intera size originale)',
      !!sorella && sorella.size === 100, sorella ? String(sorella.size) : '-');
    ok('  ed è esente da «mai primo», identica al caso parziale',
      !!sorella && sorella.inCoda === undefined);
    ok('la gamba fillata viene piazzata con le stesse regole del parziale',
      g.piazzati.some((o) => o.book === 'yes' && o.side === 'SELL' && o.inCoda === true));

    // ── LA PROVA CHE IL PERCORSO È UNO SOLO ──
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, 'modalita-chiusura.js'), 'utf8');
    const corpo = src.slice(src.indexOf('function residuiDaCancellare'), src.indexOf('function validoPerRipianificare'));
    ok('`residuiDaCancellare` non ramifica su parziale/totale: guarda il LIBRO',
      !/FILL_COMPLETO|FILL_PARZIALE|tipoFill/.test(corpo));
    const acSrc = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    ok('  e auto-close tratta i due casi con la stessa condizione, non con due rami',
      (acSrc.match(/fill\.tipo === FILL_PARZIALE \|\| fill\.tipo === FILL_COMPLETO/g) || []).length >= 1);
  }

  console.log('\n════ 9 · FAIL-CLOSED E NON REGRESSIONE ════');
  {
    const rules = regoleFinte();
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40 });
    // Nessuna dep `chiusura` cablata ⇒ comportamento identico a prima del lavoro.
    const piazzati = [], cancellati = [];
    const e = await AC.completaCoppia({
      marketId: '0xMKT', tok: 'TOKY', book: 'yes', rules, liv, dpMerge: null,
      attesa: null, chiaveMerge: 'k', reg: { leggi: () => null, segna: () => {}, pulisci: () => {} },
      cancelOrderIds: [], prezzoCarico: 0.40,
      ordiniMercato: [{ orderId: 'RESIDUO', tokenId: 'TOKY', side: 'BUY', size: 100, sizeRemaining: 60 }],
      deps: {
        placeOrder: async (o) => { piazzati.push(o); return { ok: true, orderId: 'Z' }; },
        cancelOrder: async (o) => { cancellati.push(o.orderId); return { ok: true }; },
      },
      audit: () => {}, t0: 1786500000000,
    });
    ok('senza il registro iniettato NON si cancella niente (dep non cablata ⇒ comportamento di prima)',
      cancellati.length === 0, cancellati.join(','));
    ok('  e la sorella torna a dichiarare inCoda:true',
      piazzati.filter((o) => !o.attraversaApposta).every((o) => o.inCoda === true));
    ok('  ma il completamento viene tentato lo stesso', e.esito === 'piazzato');

    // Cancellazione fallita ⇒ non blocca la gestione (è un BUY, non un ordine di segno opposto).
    // ⚠ L'ordine che si cancella all'ingresso e' la SORELLA sovradimensionata, non il residuo della
    // gamba riempita: dal 15 agosto 2026 quello resta a libro fino a coppia completa.
    const chiusura = registroFinto();
    const g = await giro({ liv, rules, chiusura, prezzoCarico: 0.40, placeOk: () => true, cancelOk: false,
      ordiniMercato: [{ orderId: 'SORELLA', tokenId: 'TOKN', side: 'BUY', size: 100, sizeRemaining: 100 }] });
    ok('una cancellazione fallita non ferma la chiusura', g.esito.esito === 'piazzato', g.esito.motivo);
    ok('  e resta a verbale', g.auditRighe.some((r) => /cancellazione-fallita/.test(r.outcome || '')));
  }

  console.log('\n════ 10 · CHIUSURA FORZATA PRE-SCADENZA ════');
  {
    const rules = regoleFinte();
    const ora = 1786500000000;
    const h = (x) => ora + x * 3600000;
    const dp = { yes: { bids: [{ price: 0.30 }], asks: [{ price: 0.42 }] },
      no: { bids: [{ price: 0.55 }], asks: [{ price: 0.75 }] } };
    // Carico 40c, 40 share scoperte. A 2 ore: vendere a 30c costa $4; comprare NO a 75c porta la coppia
    // a 115c, cioe' OLTRE il tetto ordinario di 110c — il caso che la regola deve ammettere.
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40 });

    const c4 = registroFinto();
    const g4 = await giro({ liv, rules, ordiniMercato: [], chiusura: c4, prezzoCarico: 0.40, dpMerge: dp,
      placeOk: () => true, scadenza: h(4) });
    ok('a 4 ore NON scatta la chiusura forzata',
      !g4.auditRighe.some((r) => /chiusura-forzata/.test(r.outcome || '')));
    ok('  e il tetto della coppia resta quello ordinario: nessun ordine col tetto allargato',
      !g4.piazzati.some((o) => o.tettoCoppiaCents === 200));

    const c2 = registroFinto();
    const g2 = await giro({ liv, rules, ordiniMercato: [], chiusura: c2, prezzoCarico: 0.40, dpMerge: dp,
      placeOk: () => true, scadenza: h(2) });
    ok('a 2 ore SCATTA la chiusura forzata', g2.esito.chiusuraForzata === true, g2.esito.motivo);
    ok('  ed e a verbale con motivo esplicito',
      g2.auditRighe.some((r) => r.outcome === 'chiusura-forzata-pre-scadenza'));
    ok('  con il COSTO effettivo misurato', (() => {
      const r = g2.auditRighe.find((x) => x.outcome === 'chiusura-forzata-pre-scadenza');
      return r && Number.isFinite(r.observed.costoUsd);
    })());
    ok('  e con le ore residue', (() => {
      const r = g2.auditRighe.find((x) => x.outcome === 'chiusura-forzata-pre-scadenza');
      return r && Math.abs(r.observed.oreAllaScadenza - 2) < 0.01;
    })());
    ok('sceglie la VENDITA: e l unico percorso senza tetto di prezzo, quindi quello che chiude prima',
      g2.esito.percorso === 'vendita', String(g2.esito.percorso));
    ok('  dichiarata come attraversamento voluto',
      g2.piazzati[0].side === 'SELL' && g2.piazzati[0].attraversaApposta === true);
    ok('  per l INTERA posizione posseduta', g2.piazzati[0].size === 40);
    ok('  al miglior bid, anche in perdita sul carico',
      g2.piazzati[0].price === 0.30 && g2.piazzati[0].price < 0.40);
    ok('  cioe NON il percorso piu economico: vendere costa $4,00 di perdita certa',
      Math.abs(g2.esito.costoUsd - 4) < 0.001, String(g2.esito.costoUsd));

    const c2b = registroFinto();
    const g2b = await giro({ liv, rules, ordiniMercato: [], chiusura: c2b, prezzoCarico: 0.40, dpMerge: dp,
      placeOk: (o) => o.side === 'BUY', scadenza: h(2) });
    ok('vendita rifiutata ⇒ si tenta l acquisto della controparte', g2b.esito.percorso === 'acquisto-controparte');
    ok('  a un costo coppia OLTRE il tetto ordinario (40 + 75 = 115c)',
      Math.abs(g2b.piazzati.find((o) => o.side === 'BUY').price - 0.75) < 1e-9);
    ok('  dichiarando il tetto al massimo che il gate a valle accetta (200c)',
      g2b.piazzati.find((o) => o.side === 'BUY').tettoCoppiaCents === 200);

    const c2k = registroFinto();
    const gk = await giro({ liv, rules, ordiniMercato: [], chiusura: c2k, prezzoCarico: 0.40, dpMerge: dp,
      placeOk: () => ({ ok: false, gate: 'kill-switch', reason: 'KILL attivo' }), scadenza: h(2) });
    ok('con il KILL attivo NESSUN ordine passa, nemmeno in chiusura forzata', !gk.esito.chiusuraForzata);
    ok('  e il rifiuto resta a verbale col gate del kill',
      gk.auditRighe.some((r) => /chiusura-forzata-pre-scadenza-reject-kill-switch/.test(r.outcome || '')));
    ok('  il kill NON e reimplementato in auto-close: lo applica l imbuto manuale come primo gate', (() => {
      const mo = require('fs').readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
      return /killSwitch\.killStatus/.test(mo);
    })());

    const cComp = registroFinto();
    const livComp = livelloVero({ sizePosseduta: 40, sizeAltroLato: 40, prezzoCarico: 0.40 });
    ok('una coppia completa non ha niente di scoperto', livComp.numeri.mancaAllaCoppia <= 0);
    ok('  quindi la chiusura forzata NON la tocca, nemmeno a 2 ore',
      MC.chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: livComp.numeri.mancaAllaCoppia, ora }).forza === false);
    const gc = await giro({ liv: livComp, rules, ordiniMercato: [], chiusura: cComp, prezzoCarico: 0.40,
      dpMerge: dp, placeOk: () => true, scadenza: h(2) });
    ok('  e nessuna vendita a mercato parte su di lei',
      !gc.piazzati.some((o) => o.side === 'SELL' && o.attraversaApposta === true));
  }

  console.log('\n════ 11 · PERSISTENZA: UN RIAVVIO NON PERDE LA MODALITA CHIUSURA ════');
  {
    const fs = require('fs');
    const os = require('os');
    // Registro su DISCO, con lo stesso pattern di merge-attese.json (scrittura atomica tmp+rename).
    // File in una directory temporanea: nessun file di produzione viene toccato.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
    const FILE = path.join(dir, 'modalita-chiusura.json');
    const suDisco = () => {
      const leggi = () => { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j.coppie || {}; } catch { return {}; } };
      const scrivi = (c) => { fs.writeFileSync(FILE + '.tmp', JSON.stringify({ atIso: new Date().toISOString(), coppie: c }, null, 1)); fs.renameSync(FILE + '.tmp', FILE); };
      return {
        leggi: (m, b) => MC.leggiChiusura(leggi(), m, b),
        entra: (a) => { const r = MC.entraInChiusura({ ...a, registro: leggi() }); if (r.voce) scrivi(r.registro); return r; },
        attiva: (a) => { const r = MC.attivaRegole({ ...a, registro: leggi() }); if (r.attivate) scrivi(r.registro); return r; },
        fase: (a) => { const r = MC.segnaFase({ ...a, registro: leggi() }); if (r.cambiata) scrivi(r.registro); return r; },
        esci: (a) => { const r = MC.esciDaChiusura({ ...a, registro: leggi() }); if (r.uscita) scrivi(r.registro); return r; },
      };
    };

    const rules = regoleFinte();
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40 });
    const prima = suDisco();
    await giro({ liv, rules, ordiniMercato: [], chiusura: prima, prezzoCarico: 0.40, placeOk: () => true });
    ok('lo stato e stato scritto su disco', fs.existsSync(FILE));
    const salvato = JSON.parse(fs.readFileSync(FILE, 'utf8')).coppie['0xMKT:yes'];
    ok('  contiene marketId e lato fillato', salvato.marketId === '0xMKT' && salvato.book === 'yes');
    ok('  le share fillate', salvato.sizeFillata === 40);
    ok('  il timestamp del primo fill', salvato.da === 1786500000000);
    ok('  e la FASE corrente', typeof salvato.fase === 'string' && salvato.fase.length > 0, String(salvato.fase));

    // ── IL RIAVVIO: un processo NUOVO che rilegge solo dal file ──
    const dopo = suDisco();
    const ripreso = dopo.leggi('0xMKT', 'yes');
    ok('DOPO IL RIAVVIO la coppia risulta ancora in modalita chiusura', ripreso.attiva === true);
    ok('  con le regole ancora attive: non torna a essere un mercato normale', ripreso.regoleAttive === true);
    ok('  e con il timestamp ORIGINALE, non quello del riavvio', ripreso.da === 1786500000000);
    ok('  e la fase ritrovata', ripreso.fase !== null);

    // ── TRE FILL PARZIALI SUCCESSIVI ──
    const cum = suDisco();
    cum.entra({ marketId: '0xC', book: 'yes', tipoFill: FILL_COMPLETO, fillOrdine: MC.FILL_ORDINE_PARZIALE, sizeFillata: 20, ora: 1000 });
    // Il venue riporta la POSIZIONE, che e' gia' cumulativa: 20 → 35 → 65.
    cum.entra({ marketId: '0xC', book: 'yes', tipoFill: FILL_COMPLETO, fillOrdine: MC.FILL_ORDINE_PARZIALE, sizeFillata: 35, ora: 2000 });
    cum.entra({ marketId: '0xC', book: 'yes', tipoFill: FILL_COMPLETO, fillOrdine: MC.FILL_ORDINE_PARZIALE, sizeFillata: 65, ora: 3000 });
    const c = cum.leggi('0xC', 'yes');
    ok('tre fill successivi ⇒ 65 share cumulative (20 + 15 + 30)', c.sizeFillata === 65, String(c.sizeFillata));
    ok('  e il timestamp resta quello del PRIMO fill', c.da === 1000, String(c.da));
    ok('  la storia conserva le tre osservazioni', c.osservazioni.length === 3, String(c.osservazioni.length));
    ok('  con gli INCREMENTI ricostruibili: 20, 15, 30',
      c.osservazioni.map((o) => o.incremento).join(',') === '20,15,30',
      c.osservazioni.map((o) => o.incremento).join(','));
    ok('  e NON si sommano le osservazioni (sarebbe 120, quasi il doppio del vero)', c.sizeFillata !== 120);
    // E la sorella si riadatta alla size cumulativa a ogni fill.
    const livCum = livelloVero({ sizePosseduta: 65, sizeAltroLato: 0, prezzoCarico: 0.40 });
    const gCum = await giro({ liv: livCum, rules, ordiniMercato: [], chiusura: suDisco(), prezzoCarico: 0.40, placeOk: () => true });
    ok('  e la sorella viene dimensionata sulla size CUMULATIVA (65)',
      gCum.piazzati.some((o) => o.book === 'no' && o.side === 'BUY' && o.size === 65));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n════ 12 · COPPIA COMPLETA SENZA PASSARE DALLA MODALITA CHIUSURA ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    // Fill simultaneo su entrambe le gambe: 40 e 40. Non c e mai stata una gamba scoperta.
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 40, prezzoCarico: 0.40 });
    ok('il verdetto e MERGE, non un livello di completamento', liv.azione === 'merge', String(liv.azione));
    let fusa = null;
    const e = await AC.completaCoppia({
      marketId: '0xMKT', tok: 'TOKY', book: 'yes', rules, liv, dpMerge: null,
      attesa: null, chiaveMerge: 'k', reg: { leggi: () => null, segna: () => {}, pulisci: () => {} },
      cancelOrderIds: [], prezzoCarico: 0.40, ordiniMercato: [],
      deps: {
        chiusura,
        // La forma che `fondiCoppia` legge davvero: `eseguito:true` (non `ok`), come il relayer.
        mergeOnChain: async (a) => { fusa = a; return { eseguito: true, transactionHash: '0xTX', transactionID: 'T1', stato: 'STATE_CONFIRMED' }; },
        placeOrder: async () => ({ ok: false, gate: 'non-dovrebbe-servire' }),
        cancelOrder: async () => ({ ok: true }),
      },
      audit: () => {}, t0: 1786500000000,
    });
    ok('il merge parte SUBITO, senza passare dalla modalita chiusura', e.esito === 'fuso', e.motivo);
    ok('  per l intera coppia', e.size === 40);
    ok('  e la modalita chiusura non e mai stata aperta su questa coppia',
      chiusura.leggi('0xMKT', 'yes').attiva === false);
    ok('  cioe il flusso NON presuppone che ci sia sempre stata una gamba scoperta', fusa !== null);
  }

  console.log('\n════ 13 · IL LIVELLO 1 PUO FINALMENTE ATTRAVERSARE ════');
  {
    const rules = regoleFinte();
    const chiusura = registroFinto();
    const liv = livelloVero({ sizePosseduta: 40, sizeAltroLato: 0, prezzoCarico: 0.40,
      asksAltroLato: [{ price: 0.55, size: 100 }] });
    ok('il verdetto e il Livello 1', liv.livello === 1);
    const g = await giro({ liv, rules, ordiniMercato: [], chiusura, prezzoCarico: 0.40,
      placeOk: (o) => o.attraversaApposta === true });
    const taker = g.piazzati.find((o) => o.attraversaApposta === true);
    ok('il taker dichiara TUTTI E TRE i campi che la sua eccezione richiede', !!taker
      && taker.completaCoppia === true
      && Number.isFinite(taker.prezzoCaricoCoppia)
      && Number.isFinite(taker.tettoCoppiaCents));
    ok('  il carico dichiarato e quello vero della posizione', taker.prezzoCaricoCoppia === 0.40);
    ok('  e il tetto dichiarato e 100c, il minimo che il gate accetta',
      taker.tettoCoppiaCents === 100, String(taker.tettoCoppiaCents));
    ok('  mentre il vincolo VERO resta piu stretto e sta a monte: decidiLivello non propone sopra 99c',
      (0.40 + taker.price) * 100 <= 99 + 1e-9, `${((0.40 + taker.price) * 100).toFixed(1)}c`);
    // La verifica che conta: l'aritmetica che il gate a valle RIFA' deve tornare.
    ok('  e l aritmetica del gate torna: carico + prezzo <= tetto',
      (taker.prezzoCaricoCoppia + taker.price) * 100 <= taker.tettoCoppiaCents + 1e-9,
      `${((taker.prezzoCaricoCoppia + taker.price) * 100).toFixed(1)}c vs ${taker.tettoCoppiaCents}c`);
    // E il gate VERO, non una sua imitazione: si rifa' la stessa condizione booleana di manual-order.
    const mo = require('fs').readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
    ok('  il gate a valle chiede esattamente questi tre campi',
      /spec\.attraversaApposta === true && spec\.completaCoppia === true/.test(mo)
      && /prezzoCaricoCoppia/.test(mo) && /tettoCoppiaCents/.test(mo));
    ok('  e la regola anti-incrocio NON e stata toccata: resta rifiutato chi non li dichiara',
      /lato === 'BUY'\s*\n?\s*&& spec\.attraversaApposta === true && spec\.completaCoppia === true/.test(mo)
      || /completaCoppiaOk/.test(mo));
  }

  console.log(`\n${fail === 0 ? '✅ TUTTI VERDI' : '❌'}: ${pass} passati, ${fail} falliti\n`);
  if (fail > 0) process.exit(1);
})();

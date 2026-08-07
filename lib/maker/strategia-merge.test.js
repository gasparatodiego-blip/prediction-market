#!/usr/bin/env node
'use strict';
// LA STRATEGIA A TRE LIVELLI DOPO UN FILL: COMPLETARE LA COPPIA, NON SVENDERE LA GAMBA.
//
// 1 YES + 1 NO = $1 per costruzione. Se la coppia costa meno di $1 il profitto e' matematico. Da qui i
// tre livelli: prenderla al volo se l'altro lato e' gia' economico (1), aspettarla da maker sotto un
// tetto (2), e solo se non arriva ripiegare sull'uscita classica a carico+1% (3).
//
// ═══ LO STATO REALE, PERCHE' I TEST NON LO NASCONDANO ════════════════════════════════════════════
// Il merge on-chain NON e' eseguibile dallo stack attuale (vedi l'intestazione di strategia-merge.js:
// nessun percorso di scrittura on-chain, token nel funder-contratto e non nell EOA, funder senza MATIC,
// deposit wallet ERC-1271, mercati neg-risk). Senza merge, completare la coppia immobilizza capitale
// invece di liberarlo — un'operazione diversa da quella per cui i livelli esistono. Percio'
// MERGE_STRATEGY_ENABLED e' false, e c'e' un test che lo verifica: se un giorno viene acceso senza che
// il merge esista, quel test deve fallire e dire perche'.
//
// Questo file prova la DECISIONE, che e' pura. Nessun ordine, nessuna rete.

const M = require('./strategia-merge');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

const NOW = 1_700_000_000_000;
const MKT = '0xc16fade4bb';
const REGOLE = { readable: true, tokenId: 'TY', tokenIdNo: 'TN' };

(async () => {

  console.log('\n══ 1 · IL TETTO DEL SECONDO LATO');
  {
    // Riempito NO a 51¢ ⇒ posso pagare YES al massimo 100 − 51 − 1 = 48¢.
    ok('51¢ pagati ⇒ tetto 48¢', vicino(M.tettoSecondoLato(0.51), 0.48), `${(M.tettoSecondoLato(0.51) * 100).toFixed(0)}¢`);
    ok('  il margine e la costante, non un numero sparso', M.MERGE_MIN_MARGIN_CENTS === 1,
      `MERGE_MIN_MARGIN_CENTS = ${M.MERGE_MIN_MARGIN_CENTS}`);
    ok('un lato pagato 99.5¢ non lascia spazio', M.tettoSecondoLato(0.995) === null,
      'la coppia costerebbe piu di $1: nessun tetto valido');
    ok('  e un carico illeggibile non produce un tetto indovinato', M.tettoSecondoLato(null) === null);
  }

  console.log('\n══ 2 · LIVELLO 1 · L ALTRO LATO E GIA ECONOMICO');
  {
    const d = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51,
      asksAltroLato: [{ price: 0.46, size: 60 }, { price: 0.47, size: 80 }], now: NOW,
    });
    ok('sceglie il Livello 1', d.livello === 1 && d.azione === 'compra-taker', d.motivo);
    ok('  compra tutta la size che serve', vicino(d.size, 100), `${d.size} share`);
    // 60 a 0.46 + 40 a 0.47 = 27.6 + 18.8 = 46.4 ⇒ medio 0.464. Coppia = 51 + 46.4 = 97.4¢.
    ok('  camminando la scala dal livello piu economico', vicino(d.numeri.costoMedioAlVolo, 0.464),
      `${(d.numeri.costoMedioAlVolo * 100).toFixed(1)}¢ medi`);
    ok('  e la coppia costa 97.4¢, cioe 2.6¢ di profitto certo per share',
      vicino(d.numeri.coppiaCents, 97.4, 1e-2), `${d.numeri.coppiaCents}¢`);
  }

  console.log('\n══ 3 · IL TETTO NON SI VIOLA MAI');
  {
    // Tetto 48¢: il primo livello e' dentro, il secondo no. Si prende solo il primo.
    const d = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51,
      asksAltroLato: [{ price: 0.48, size: 30 }, { price: 0.49, size: 500 }], now: NOW,
    });
    ok('si ferma al primo livello troppo caro', vicino(d.size, 30), `${d.size} share, non 100`);
    ok('  il prezzo peggiore pagato e esattamente il tetto', vicino(d.prezzo, 0.48), `${(d.prezzo * 100).toFixed(0)}¢`);
    ok('  e il residuo passa al Livello 2, dichiarato', vicino(d.numeri.residuo, 70), `${d.numeri.residuo} share`);

    // Nessun livello entro il tetto ⇒ niente acquisto al volo.
    const caro = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51,
      asksAltroLato: [{ price: 0.49, size: 500 }], now: NOW,
    });
    ok('con tutto sopra il tetto NON si compra nulla al volo', caro.livello === 2 && caro.azione === 'maker-con-tetto', caro.motivo);
    ok('  e il tetto passato al maker e 48¢', vicino(caro.tetto, 0.48), `${(caro.tetto * 100).toFixed(0)}¢`);

    // La prova diretta della regola 11: mai un acquisto sopra 100 − costo − margine.
    let violazioni = 0;
    for (let carico = 5; carico <= 95; carico += 5) {
      for (const ask of [0.10, 0.30, 0.44, 0.48, 0.50, 0.70, 0.90]) {
        const r = M.decidiLivello({
          book: 'no', sizePosseduta: 10, prezzoCarico: carico / 100,
          asksAltroLato: [{ price: ask, size: 1000 }], now: NOW,
        });
        if (r.azione !== 'compra-taker') continue;
        const limite = 100 - carico - M.MERGE_MIN_MARGIN_CENTS;
        if (r.prezzo * 100 > limite + 1e-9) violazioni += 1;
      }
    }
    ok('su 133 combinazioni carico×ask, zero acquisti sopra il tetto', violazioni === 0, `${violazioni} violazioni`);
  }

  console.log('\n══ 4 · LIVELLO 2 → LIVELLO 3 AL TIMEOUT');
  {
    const asks = [{ price: 0.49, size: 500 }];
    const dentro = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: asks,
      attesaDaMs: NOW - 59 * 60_000, now: NOW,
    });
    ok('a 59 minuti si aspetta ancora', dentro.livello === 2, `attesa ${dentro.numeri.attesaMin} min`);

    const fuori = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: asks,
      attesaDaMs: NOW - 61 * 60_000, now: NOW,
    });
    ok('a 61 minuti si ripiega sul Livello 3', fuori.livello === 3 && fuori.azione === 'auto-close', fuori.motivo);
    ok('  e il motivo dice di cancellare prima l ordine di completamento',
      /si cancella l ordine di completamento/.test(fuori.motivo));
    ok('  il timeout e la costante', M.MERGE_WAIT_TIMEOUT_MIN === 60, `MERGE_WAIT_TIMEOUT_MIN = ${M.MERGE_WAIT_TIMEOUT_MIN}`);

    // Il timeout si controlla PRIMA di riproporre il Livello 2: altrimenti l'attesa si rinnoverebbe
    // da sola a ogni giro e il ripiego non scatterebbe mai.
    const moltoOltre = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: asks,
      attesaDaMs: NOW - 600 * 60_000, now: NOW,
    });
    ok('  e un attesa lunghissima non torna al Livello 2', moltoOltre.livello === 3);
  }

  console.log('\n══ 5 · FILL PARZIALE: CONTA LA QUANTITA POSSEDUTA');
  {
    // L'ordine era da 100, ne sono stati riempiti 30. La coppia si ragiona su 30.
    const d = M.decidiLivello({
      book: 'no', sizePosseduta: 30, prezzoCarico: 0.51,
      asksAltroLato: [{ price: 0.46, size: 1000 }], now: NOW,
    });
    ok('si compra 30, non 100', vicino(d.size, 30), `${d.size} share`);

    // E se meta' coppia c'e' gia', si compra solo cio' che manca.
    const meta = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, sizeAltroLato: 40,
      asksAltroLato: [{ price: 0.46, size: 1000 }], now: NOW,
    });
    ok('  con 40 gia in casa se ne comprano 60', vicino(meta.size, 60), `mancaAllaCoppia = ${meta.numeri.mancaAllaCoppia}`);

    const completa = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, sizeAltroLato: 100,
      asksAltroLato: [{ price: 0.46, size: 1000 }], now: NOW,
    });
    ok('  e una coppia gia completa non compra niente: resta solo da fondere',
      completa.azione === 'merge' && vicino(completa.size, 100), completa.motivo);
  }

  console.log('\n══ 6 · LE COPPIE GIA IN CASA');
  {
    const coppie = M.coppieFondibili([
      { conditionId: MKT, tokenId: 'TY', size: 120, avgPrice: 0.44 },
      { conditionId: MKT, tokenId: 'TN', size: 80, avgPrice: 0.52 },
      { conditionId: '0xALTRO', tokenId: 'TN', size: 51, avgPrice: 0.80 },
    ], (id) => (id === MKT ? REGOLE : { readable: true, tokenId: 'X', tokenIdNo: 'TN' }));
    ok('trova la coppia sovrapponibile', coppie.length === 1 && coppie[0].marketId === MKT, `${coppie.length} coppia/e`);
    ok('  per la quantita MINIMA fra i due lati', vicino(coppie[0].size, 80), `${coppie[0].size} share (120 YES, 80 NO)`);
    ok('  con il profitto che il merge libererebbe', vicino(coppie[0].profittoUsd, (1 - 0.96) * 80, 1e-3),
      `$${coppie[0].profittoUsd} su una coppia costata ${(coppie[0].costoCoppia * 100).toFixed(0)}¢`);
    ok('  e un lato solo non e una coppia', !coppie.some((c) => c.marketId === '0xALTRO'));

    const senzaCarico = M.coppieFondibili([
      { conditionId: MKT, tokenId: 'TY', size: 10, avgPrice: null },
      { conditionId: MKT, tokenId: 'TN', size: 10, avgPrice: 0.5 },
    ], () => REGOLE);
    ok('un carico illeggibile lascia il profitto a null, non a zero',
      senzaCarico.length === 1 && senzaCarico[0].profittoUsd === null);
  }

  console.log('\n══ 7 · IL RIPIEGO QUANDO NON SI PUO DECIDERE');
  {
    const senzaCarico = M.decidiLivello({ book: 'no', sizePosseduta: 100, prezzoCarico: null, now: NOW });
    ok('carico illeggibile ⇒ Livello 3, non un tetto indovinato',
      senzaCarico.livello === 3 && senzaCarico.azione === 'auto-close', senzaCarico.motivo);

    const troppoCaro = M.decidiLivello({ book: 'no', sizePosseduta: 100, prezzoCarico: 0.995, now: NOW });
    ok('lato pagato 99.5¢ ⇒ Livello 3: la coppia costerebbe piu di $1',
      troppoCaro.livello === 3, troppoCaro.motivo);

    const niente = M.decidiLivello({ book: 'no', sizePosseduta: 0, prezzoCarico: 0.51, now: NOW });
    ok('nessuna posizione ⇒ nessuna azione', niente.azione === 'niente');

    const feedMuto = M.decidiLivello({ book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: null, now: NOW });
    ok('book dell altro lato non leggibile ⇒ si aspetta da maker, non si compra al buio',
      feedMuto.livello === 2 && feedMuto.size === 100, feedMuto.motivo);
  }

  console.log('\n══ 8 · L INTERRUTTORE E SPENTO, E IL MOTIVO E SCRITTO');
  {
    ok('MERGE_STRATEGY_ENABLED e false', M.MERGE_STRATEGY_ENABLED === false,
      'la meccanica e pronta e non muove un dollaro');
    ok('  e il motivo viaggia col codice, non in un commento',
      /merge on-chain non eseguibile/.test(M.MERGE_DISABLED_REASON), M.MERGE_DISABLED_REASON.slice(0, 90) + '…');
    // Se qualcuno accende l'interruttore, questo test cade e dice cosa manca prima.
    ok('  accenderlo senza una via per il merge deve far cadere questo banco',
      M.MERGE_STRATEGY_ENABLED === false,
      'completare la coppia senza poterla fondere immobilizza capitale invece di liberarlo: e una decisione dell operatore');
  }

  console.log(`\nstrategia merge: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

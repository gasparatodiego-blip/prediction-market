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
    // ⚠ IL TETTO E' `MERGE_TETTO_COPPIA_CENTS − carico`, e si LEGGE dalla costante invece di
    // ricopiarne il valore: dal 15 agosto 2026 vale 101¢ (era 99¢), e un test che fotografa il numero
    // diventa rosso a ogni giro di manopola pur essendo il codice corretto (§5.3).
    const T = M.MERGE_TETTO_COPPIA_CENTS;
    const atteso51 = (T - 51) / 100;
    ok(`51¢ pagati ⇒ tetto ${(T - 51).toFixed(0)}¢`, vicino(M.tettoSecondoLato(0.51), atteso51), `${(M.tettoSecondoLato(0.51) * 100).toFixed(0)}¢`);
    ok('  il margine e DERIVATO dal tetto, non un secondo numero',
      M.MERGE_MIN_MARGIN_CENTS === 100 - T, `MERGE_MIN_MARGIN_CENTS = ${M.MERGE_MIN_MARGIN_CENTS}, tetto ${T}¢`);
    ok('  e il tetto non supera MAI 100¢, cioe non produce un prezzo fuori dai limiti del libro',
      M.tettoSecondoLato(0.001) <= 1 + 1e-12, `${(M.tettoSecondoLato(0.001) * 100).toFixed(1)}¢`);
    // Il carico che non lascia spazio dipende dal tetto: a 101¢ serve un carico oltre il tetto stesso.
    ok(`un lato pagato ${(T / 100).toFixed(2)} non lascia spazio`, M.tettoSecondoLato(T / 100) === null,
      'la coppia costerebbe piu del tetto: nessun tetto valido');
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
    // Le due scale si costruiscono DAL TETTO, così la fixture segue la costante invece di inseguirla:
    // un livello esattamente al tetto (che deve passare) e uno un centesimo sopra (che deve fermare).
    const tet = M.tettoSecondoLato(0.51);
    const d = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51,
      asksAltroLato: [{ price: tet, size: 30 }, { price: +(tet + 0.01).toFixed(6), size: 500 }], now: NOW,
    });
    ok('si ferma al primo livello troppo caro', vicino(d.size, 30), `${d.size} share, non 100`);
    ok('  il prezzo peggiore pagato e esattamente il tetto', vicino(d.prezzo, tet), `${(d.prezzo * 100).toFixed(0)}¢`);
    ok('  e il residuo passa al Livello 2, dichiarato', vicino(d.numeri.residuo, 70), `${d.numeri.residuo} share`);

    // Nessun livello entro il tetto ⇒ niente acquisto al volo. L'ask si costruisce SOPRA il tetto
    // calcolato, non su un 49¢ scritto a mano che il tetto di oggi accetterebbe.
    const sopraIlTetto = +(tet + 0.01).toFixed(6);
    const caro = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51,
      asksAltroLato: [{ price: sopraIlTetto, size: 500 }], now: NOW,
    });
    ok('con tutto sopra il tetto NON si compra nulla al volo', caro.livello === 2 && caro.azione === 'maker-con-tetto', caro.motivo);
    ok(`  e il tetto passato al maker e ${(tet * 100).toFixed(0)}¢`, vicino(caro.tetto, tet), `${(caro.tetto * 100).toFixed(0)}¢`);

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
    // ⚠ L'ask deve stare SOPRA il tetto, o il Livello 1 comprerebbe al volo e il timeout non si
    // vedrebbe mai. Si deriva dal tetto invece di fissarlo, come sopra. E le due attese si prendono
    // attorno a `MERGE_WAIT_TIMEOUT_MIN`, non attorno a 60.
    const asks = [{ price: +(M.tettoSecondoLato(0.51) + 0.01).toFixed(6), size: 500 }];
    const TO = M.MERGE_WAIT_TIMEOUT_MIN;
    const dentro = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: asks,
      attesaDaMs: NOW - (TO - 1) * 60_000, now: NOW,
    });
    ok(`a ${TO - 1} minuti si aspetta ancora`, dentro.livello === 2, `attesa ${dentro.numeri.attesaMin} min`);

    const fuori = M.decidiLivello({
      book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: asks,
      attesaDaMs: NOW - (TO + 1) * 60_000, now: NOW,
    });
    ok(`a ${TO + 1} minuti si ripiega sul Livello 3`, fuori.livello === 3 && fuori.azione === 'auto-close', fuori.motivo);
    ok('  e il motivo dice di cancellare prima l ordine di completamento',
      /si cancella l ordine di completamento/.test(fuori.motivo));
    ok('  il timeout e una costante positiva, e si legge da li', Number.isFinite(M.MERGE_WAIT_TIMEOUT_MIN) && M.MERGE_WAIT_TIMEOUT_MIN > 0,
      `MERGE_WAIT_TIMEOUT_MIN = ${M.MERGE_WAIT_TIMEOUT_MIN}`);

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

    // ⚠ Il carico che NON lascia spazio dipende dal tetto: a 101¢ un lato pagato 99,5¢ ne lascia
    // ancora 1,5, ed e' giusto che il Livello 2 ci provi. Si prende quindi il tetto stesso.
    const oltreIlTetto = M.MERGE_TETTO_COPPIA_CENTS / 100;
    const troppoCaro = M.decidiLivello({ book: 'no', sizePosseduta: 100, prezzoCarico: oltreIlTetto, now: NOW });
    ok(`lato pagato ${(oltreIlTetto * 100).toFixed(1)}¢ ⇒ Livello 3: la coppia costerebbe piu del tetto`,
      troppoCaro.livello === 3, troppoCaro.motivo);

    const niente = M.decidiLivello({ book: 'no', sizePosseduta: 0, prezzoCarico: 0.51, now: NOW });
    ok('nessuna posizione ⇒ nessuna azione', niente.azione === 'niente');

    const feedMuto = M.decidiLivello({ book: 'no', sizePosseduta: 100, prezzoCarico: 0.51, asksAltroLato: null, now: NOW });
    ok('book dell altro lato non leggibile ⇒ si aspetta da maker, non si compra al buio',
      feedMuto.livello === 2 && feedMuto.size === 100, feedMuto.motivo);
  }

  console.log('\n══ 8 · L INTERRUTTORE E ACCESO, E CIO CHE COMPORTA E SCRITTO');
  {
    // L'8 agosto 2026 l'operatore ha acceso i Livelli 1 e 2 in chat, sapendo che senza merge on-chain
    // la coppia completata IMMOBILIZZA capitale fino alla risoluzione invece di liberarlo subito.
    // Questo banco non difende piu' lo «spento»: difende che acceso e spento non possano essere una
    // svista. Chi lo rimette a false deve passare di qui e aggiornare anche l'intestazione.
    ok('MERGE_STRATEGY_ENABLED e true', M.MERGE_STRATEGY_ENABLED === true,
      'i Livelli 1 e 2 comprano davvero il secondo lato — auto-close.js li esegue');
    ok('  il motivo dello spegnimento resta leggibile per chi volesse tornare indietro',
      /merge on-chain non eseguibile/.test(M.MERGE_DISABLED_REASON), M.MERGE_DISABLED_REASON.slice(0, 90) + '…');

    // LA COSA CHE NON DEVE POTER CAMBIARE IN SILENZIO. Fino al 9 agosto 2026 questa riga pretendeva
    // `CTF_RELAYER_ENABLED === false`: accendere i due livelli NON aveva acceso il merge on-chain, e un
    // flip silenzioso doveva far cadere il test. L'operatore lo ha acceso esplicitamente in chat il
    // 9 agosto, quindi la costante e' cambiata — ma la PROPRIETA' che il test difende non e' cambiata:
    // il valore e l'intestazione che lo racconta devono dire la stessa cosa. Un flip in QUALUNQUE
    // direzione senza aggiornare il testo continua a far cadere questo blocco, che e' il punto.
    const { CTF_RELAYER_ENABLED } = require('./ctf-relayer');
    const srcRel = require('fs').readFileSync(require('path').join(__dirname, 'ctf-relayer.js'), 'utf8');
    ok('  il merge on-chain e ACCESO, per decisione esplicita del 9 agosto 2026', CTF_RELAYER_ENABLED === true);
    ok('  e l intestazione del relayer lo dichiara', /ACCESO dal 9 agosto 2026/.test(srcRel));
    ok('  dicendo anche CHI lo chiama (un interruttore senza chiamante non e un interruttore)',
      /fondiCoppia/.test(srcRel));
    ok('  e che split e redeem restano senza chiamanti',
      /`splitPosition` e `redeemPosition`[^\n]*restano senza chiamanti/.test(srcRel));

    // E l'intestazione deve raccontare lo stato vero: in questo repo un commento invecchiato ha gia'
    // prodotto guasti (CLAUDE.md §5 punti 2 e 4).
    const src = require('fs').readFileSync(require('path').join(__dirname, 'strategia-merge.js'), 'utf8');
    ok('  l intestazione dice che e acceso e perche', /E PERCHE' ORA E' ACCESO|l'operatore l'ha presa/.test(src));
    ok('  e dichiara il differimento del capitale', /IMMOBILIZZA|immobilizza capitale/.test(src));
  }

  // ══ R8 · LA COPPIA COMPLETA SI FONDE PRIMA DI QUALUNQUE GUARDIA SUL PREZZO — 18 agosto 2026 ══════
  // Regola dell'operatore: «coppia completa: merge subito, sempre, senza limiti di prezzo. Il tetto di
  // 101¢ vale solo per l'acquisto della gamba mancante.»
  //
  // ⚠ SI PROVA LA PROPRIETA', NON L'ORDINE DELLE RIGHE. Un test che cercasse «la riga del merge sta
  // sopra la riga della guardia» sarebbe una fotografia del sorgente (§5.3): qui si costruiscono i due
  // stati in cui le guardie mordevano e si pretende `azione === 'merge'`.
  {
    console.log('\n── R8 · coppia completa ⇒ merge, anche senza carico ──');

    // ① IL CASO CHE PRIMA FALLIVA: coppia completa e carico NON leggibile.
    const senzaCarico = M.decidiLivello({ book: 'yes', sizePosseduta: 60, prezzoCarico: null, sizeAltroLato: 60 });
    ok('carico non leggibile + coppia completa ⇒ MERGE (prima: auto-close)', senzaCarico.azione === 'merge');
    ok('  e la size da fondere e tutta la posizione', senzaCarico.size === 60);
    ok('  e il motivo dichiara che il carico non serviva', /carico non leggibile/.test(senzaCarico.motivo));
    ok('  e il tetto viaggia a verbale come null, non come condizione', senzaCarico.tetto === null);

    // ② IL SECONDO CASO: un carico che non lascia spazio al secondo lato (tetto == null). Con
    //    `prezzoCarico` fuori dai limiti del libro `tettoSecondoLato` restituisce null.
    const senzaTetto = M.decidiLivello({ book: 'no', sizePosseduta: 12.5, prezzoCarico: 1, sizeAltroLato: 12.5 });
    ok('tetto non calcolabile + coppia completa ⇒ MERGE', senzaTetto.azione === 'merge');
    ok('  su tutte le share possedute', senzaTetto.size === 12.5);

    // ③ SOVRA-COPERTURA: piu' share sull'altro lato che su questo. `manca` e' negativo, la coppia
    //    e' completa lo stesso, e il merge deve valere anche qui.
    const sovra = M.decidiLivello({ book: 'yes', sizePosseduta: 30, prezzoCarico: null, sizeAltroLato: 45 });
    ok('sovra-copertura + carico illeggibile ⇒ MERGE', sovra.azione === 'merge');

    // ④ ⚠ LA META' CHE NON DEVE CAMBIARE: chi COMPRA continua a pretendere carico e tetto. Se questa
    //    cadesse, lo spostamento avrebbe tolto una guardia invece di riordinarla.
    const compraSenzaCarico = M.decidiLivello({ book: 'yes', sizePosseduta: 60, prezzoCarico: null, sizeAltroLato: 0 });
    ok('coppia INCOMPLETA + carico illeggibile ⇒ NON si fonde e NON si compra', compraSenzaCarico.azione === 'auto-close');
    ok('  e lo dichiara col carico', /carico non leggibile/.test(compraSenzaCarico.motivo));
    const compraSenzaTetto = M.decidiLivello({ book: 'yes', sizePosseduta: 60, prezzoCarico: 1, sizeAltroLato: 0 });
    ok('coppia INCOMPLETA + tetto non calcolabile ⇒ auto-close, non merge', compraSenzaTetto.azione === 'auto-close');

    // ⑤ E NIENTE POSIZIONE resta «niente»: il merge non deve essersi mangiato la guardia a monte.
    const nulla = M.decidiLivello({ book: 'yes', sizePosseduta: 0, prezzoCarico: null, sizeAltroLato: 10 });
    ok('nessuna posizione ⇒ niente, non merge', nulla.azione === 'niente');

    // ⑥ IL TETTO DI 101¢ VALE ANCORA, ED E' SOLO SULL'ACQUISTO. Con la coppia incompleta e un ask
    //    caro il Livello 1 non scatta: la regola dice «il tetto vale solo per la gamba mancante», non
    //    «il tetto non vale piu'».
    const caro = M.decidiLivello({ book: 'yes', sizePosseduta: 10, prezzoCarico: 0.60, sizeAltroLato: 0,
      asksAltroLato: [{ price: 0.95, size: 100 }] });
    ok('ask oltre il tetto ⇒ Livello 2, il tetto sull acquisto e intatto', caro.livello === 2 && caro.azione === 'maker-con-tetto');
  }

  console.log(`\nstrategia merge: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

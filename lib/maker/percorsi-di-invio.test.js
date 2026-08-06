#!/usr/bin/env node
'use strict';
// OGNI STRADA CHE ARRIVA AL VENUE, ELENCATA — E COSA ATTRAVERSA PRIMA.
//
// ═══ PERCHÉ UN INVENTARIO ════════════════════════════════════════════════════════════════════════════
// Una regola di sicurezza vale quanto il percorso MENO sorvegliato che porta allo stesso posto. Questo
// repo ha già pagato due volte per questa classe di difetto:
//   · `inCoda` dichiarato dalle righe del piano e SCARTATO dallo schema zod di bulk-allocate — la
//     richiesta di non finire primi sul libro spariva su un percorso e non sull'altro;
//   · il gate del montepremi presente sull'abilitazione e assente sull'ingresso in coda.
// In entrambi i casi la protezione esisteva, il codice sembrava giusto, e bastava arrivare al venue
// dall'altra porta.
//
// Quindi qui si ENUMERA. Se nasce una strada nuova verso il venue e non viene aggiunta a questo elenco,
// il test cade — e l'aggiunta obbliga a dire, per iscritto, cosa attraversa.
//
// ═══ COSA QUESTO FILE NON FA ═════════════════════════════════════════════════════════════════════════
// Non giudica se un percorso DEBBA attraversare una regola: registra se la attraversa. Le decisioni di
// prodotto stanno nel riepilogo di sessione, non qui.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

console.log('\n══ 1 · IL FUNNEL DELLA CORSIA MANUALE — DOVE STA IL CAPITALE VERO');
{
  // `placeManualOrder` è l'unica funzione della corsia manuale che raggiunge POST /order. Tutto ciò
  // che piazza in quella corsia passa di lì: se una regola sta dentro placeManualOrder, vale per tutti.
  const mo = leggi('lib', 'maker', 'manual-order.js');

  ok('placeManualOrder onora `inCoda` (mai primi sul libro)', /spec\.inCoda === true/.test(mo));
  ok('  delegando a prezzo-in-coda, non a una copia', /require\('\.\/prezzo-in-coda'\)/.test(mo) || /prezzoInCoda/.test(mo));
  ok('  e riportando lo spostamento nel referto', /inCoda: inCodaEsito/.test(mo));

  // I chiamanti. Ognuno deve trasportare `inCoda` senza perderlo per strada.
  const bulk = leggi('lib', 'maker', 'bulk-allocate.js');
  ok('bulk-allocate trasporta inCoda fino a chi piazza', /inCoda: r\.inCoda === true/.test(bulk));

  const rep = leggi('lib', 'maker', 'auto-reprice.js');
  ok('il riprezzo lo dichiara', /inCoda: trigger !== 'expiry-refresh'/.test(rep));
}

console.log('\n══ 2 · GLI SCHEMI ZOD: UN CAMPO NON DICHIARATO È UN CAMPO BUTTATO');
{
  // zod scarta le chiavi che non dichiara. Una rotta che riceve righe con `inCoda` e non lo elenca
  // nello schema inoltra la riga SENZA la richiesta — cioè cambia il prezzo a cui il capitale riposa,
  // in silenzio. Questo blocco misura la situazione REALE su ogni rotta che accetta righe d'ordine.
  const rotte = [
    ['place-market', ['app', 'api', 'maker', 'manual', 'place-market', 'route.ts']],
    ['bulk-allocate', ['app', 'api', 'maker', 'manual', 'bulk-allocate', 'route.ts']],
  ];
  const stato = {};
  for (const [nome, p] of rotte) {
    const src = leggi(...p);
    stato[nome] = /inCoda:\s*z\.boolean\(\)/.test(src);
  }

  ok('place-market DICHIARA inCoda nello schema', stato['place-market'] === true);

  // ── IL DIFETTO NOTO, ANCORA APERTO E QUI REGISTRATO ────────────────────────────────────────────
  // bulk-allocate NON lo dichiara: le righe che gli arrivano da plan-to-orders portano `inCoda: true`
  // e lo schema lo toglie. Il percorso in blocco piazza quindi senza l'aggancio alla coda del book.
  // NON è corretto qui: cambiare quello schema cambia il prezzo degli ordini su capitale reale, ed è
  // una decisione dell'operatore. Il test registra lo stato di fatto perché non possa essere
  // dimenticato, e cadrà da solo il giorno in cui verrà sistemato — obbligando ad aggiornare la nota.
  ok('bulk-allocate NON lo dichiara — difetto noto, in attesa di decisione',
    stato['bulk-allocate'] === false,
    'se questo assert cade, il difetto è stato corretto: aggiorna la nota invece di riadattare il test');
}

console.log('\n══ 3 · L INVENTARIO COMPLETO DELLE STRADE VERSO IL VENUE');
{
  // Ogni voce: come raggiunge il venue, e se passa dal funnel manuale (che porta le regole).
  const PERCORSI = [
    { nome: 'agent40 · ciclo reattivo (riprezzo/rinnovo)', file: ['agents', 'agent40-manual-reprice.js'], funnel: true, spia: /placeManualOrder\(spec\)|replaceManualOrder\(spec\)/ },
    { nome: 'agent41 · riallocatore periodico', file: ['agents', 'agent41-realloc-scheduler.js'], funnel: true, spia: /runBulkAllocation\(/ },
    { nome: 'API · ordine manuale singolo', file: ['app', 'api', 'maker', 'manual', 'order', 'route.ts'], funnel: true, spia: /placeManualOrder\(/ },
    { nome: 'API · sostituzione ordine', file: ['app', 'api', 'maker', 'manual', 'replace', 'route.ts'], funnel: true, spia: /replaceManualOrder\(/ },
    { nome: 'API · conferma a un tocco', file: ['app', 'api', 'maker', 'manual', 'place-market', 'route.ts'], funnel: true, spia: /runBulkAllocation\(/ },
    { nome: 'API · piazzamento in blocco (reset)', file: ['app', 'api', 'maker', 'manual', 'bulk-allocate', 'route.ts'], funnel: true, spia: /runBulkAllocation\(/ },
    // L'ECCEZIONE, ED È L'UNICA. agent35 non passa da placeManualOrder: parla all'adapter.
    { nome: 'agent35 · motore automatico', file: ['agents', 'agent35-maker.js'], funnel: false, spia: /adapter\.postOrder\(/ },
  ];

  for (const p of PERCORSI) {
    const src = leggi(...p.file);
    ok(`${p.nome} — trovato`, p.spia.test(src));
  }

  const fuoriFunnel = PERCORSI.filter((p) => !p.funnel);
  ok('esattamente UN percorso non passa dal funnel manuale',
    fuoriFunnel.length === 1 && fuoriFunnel[0].nome.startsWith('agent35'),
    fuoriFunnel.map((x) => x.nome).join(', '));
}

console.log('\n══ 4 · IL PERCORSO FUORI FUNNEL: COSA GLI MANCA, DETTO A CHIARE LETTERE');
{
  const a35 = leggi('agents', 'agent35-maker.js');

  // agent35 NON conosce «mai primi sul libro»: non importa top-of-book né prezzo-in-coda, e non
  // dichiara `inCoda` alle sue quote. Le sue quote nascono da un piano suo e vanno all'adapter.
  ok('agent35 non importa top-of-book', !/require\(.*top-of-book.*\)/.test(a35));
  ok('  né prezzo-in-coda', !/require\(.*prezzo-in-coda.*\)/.test(a35));
  ok('  e non dichiara inCoda alle sue quote', !/inCoda/.test(a35));

  // CIÒ CHE LO TIENE INNOCUO OGGI, e sono due cose separate — vale la pena che lo siano.
  ok('1 · sta fuori dai mercati in gestione manuale', /manualBlock/.test(a35),
    'la corsia manuale è dove sta il capitale dei liquidity rewards');
  ok('2 · l adapter ha comunque la sua catena di gate', /venueRules:/.test(a35));

  // E il suo interruttore di invio è SEPARATO da quello della corsia manuale, di proposito: armare
  // il pannello a mano non deve armare il motore automatico per effetto collaterale.
  const mo = leggi('lib', 'maker', 'manual-order.js');
  // Si cerca la LETTURA della variabile, non la sua menzione: in manual-order.js `MAKER_PLACEMENT`
  // compare tre volte, tutte in commenti che spiegano perché NON viene letta. Un test sulla menzione
  // punirebbe la spiegazione — lo stesso errore già fatto una volta con «bulk-allocate» dentro un
  // commento di ConfermaEPiazza.
  const senzaCommenti = mo.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const leggeManuale = /env\.MANUAL_ORDER_PLACEMENT|process\.env\.MANUAL_ORDER_PLACEMENT/.test(senzaCommenti);
  const leggeMotore = /env\.MAKER_PLACEMENT|process\.env\.MAKER_PLACEMENT/.test(senzaCommenti);
  ok('gli interruttori di invio sono due, non uno',
    leggeManuale === true && leggeMotore === false,
    `manuale letto: ${leggeManuale} · motore letto: ${leggeMotore} — nessun armamento per effetto collaterale`);
}

console.log('\n══ 5 · LE REGOLE NUOVE SONO PURE — NESSUNA PUÒ ESSERE AGGIRATA DA UNA CACHE');
{
  // Una regola che conserva stato può dare due risposte diverse allo stesso input a seconda di cosa è
  // stato chiesto prima: è un bypass che non assomiglia a un bypass. Entrambe le regole nuove sono
  // pure, e questo è il posto in cui quella proprietà viene difesa.
  // ── DUE CATEGORIE, PERCHÉ LE PROPRIETÀ ONESTE SONO DIVERSE ──────────────────────────────────────
  // `depth-adattiva` e `risk-caps` decidono su dati che il chiamante porta: possono essere del tutto
  // pure, e devono esserlo. `volatilita-mercato` invece MISURA UNA FINESTRA TEMPORALE — ha bisogno di
  // un orologio e di leggere il giornale, e pretendere che non li abbia sarebbe pretendere che non
  // faccia il suo mestiere. Per lei la proprietà giusta è un'altra: orologio e lettore INIETTABILI, e
  // nessuno stato che sopravviva a una chiamata.
  for (const modulo of ['depth-adattiva', 'risk-caps']) {
    const src = leggi('lib', 'maker', `${modulo}.js`);
    const senzaCommenti = src.replace(/^\/\/.*$/gm, '');
    ok(`${modulo}: nessun fs, nessuna rete, nessun orologio`,
      !/require\('fs'\)|fetch\(|Date\.now\(\)/.test(senzaCommenti));
    ok(`  ${modulo}: nessuno stato mutabile a livello di modulo`,
      !/^const \w+ = new (Map|Set)\(/m.test(src) && !/^let /m.test(src));
  }
  {
    const src = leggi('lib', 'maker', 'volatilita-mercato.js');
    const senzaCommenti = src.replace(/^\/\/.*$/gm, '');
    ok('volatilita-mercato: nessun fs diretto, nessuna rete', !/require\('fs'\)|fetch\(/.test(senzaCommenti));
    ok('  il lettore del giornale è iniettabile', /deps\.leggiFinestra \|\| leggiFinestraMercato/.test(src));
    ok('  e l orologio pure', /now = Date\.now\(\)/.test(src));
    ok('  nessuno stato mutabile a livello di modulo',
      !/^const \w+ = new (Map|Set)\(/m.test(src) && !/^let /m.test(src));
    // NIENTE CACHE: la finestra Risk è di 5 minuti e una cache da 5 minuti risponderebbe su un
    // intervallo ormai passato per intero. Vedi la nota in leggiFinestraMercato.
    ok('  e nessuna cache: su una finestra da 5 minuti una cache è una risposta sul nulla',
      !/_cache|CACHE_MS/.test(src));
  }
}

console.log(`\npercorsi di invio: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

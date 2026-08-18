#!/usr/bin/env node
'use strict';
// PRENDERE UN MERCATO IN GESTIONE MANUALE FA PARTE DEL FLUSSO DI PIAZZAMENTO.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Il gate `manual-mode-inactive` impedisce che agent35 e il pannello a mano scrivano sullo stesso libro.
// È corretto e non si tocca. Ma l'ATTIVAZIONE della proprietà manuale non faceva parte del percorso
// «Metti in coda → Conferma e piazza»: la coda accettava il mercato, l'operatore arrivava alla conferma
// finale, e lì il piazzamento veniva rifiutato — con l'unica via d'uscita di lasciare il flusso, aprire
// l'anteprima della card, premere «2 · Conferma e aggiungi», e tornare in coda. È successo su Eric
// Barlow, su Ed Markey e su Dan Green: un ostacolo sistematico, non un caso isolato.
//
// ═══ COSA CAMBIA, E COSA NON CAMBIA ══════════════════════════════════════════════════════════════════
// Cambia CHI fa l'attivazione e QUANDO: la fa la messa in coda, prima che esista un ordine da piazzare.
// NON cambia il gate: se un piazzamento arrivasse su un mercato non manuale, viene rifiutato come oggi.
// Questa modifica aggiunge un passo al flusso, non rimuove un controllo.
//
// NESSUN ORDINE REALE: qui si verifica il gate su funzioni pure, la sequenza del reset su dipendenze
// iniettate, e il resto per lettura del codice del pannello e della route.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// ⚠ I TEST STRUTTURALI DEVONO FILTRARE I COMMENTI — CLAUDE.md §5.3 lo prescrive, e questo file ne e'
// stato la prova: l'asserzione «REALLOC_SCHEDULER_DRY_RUN non e' tornato in ecosystem.config.js»
// scattava su TRE commenti che raccontano la sua rimozione (righe 320, 426, 437), cioe' esattamente
// sul testo che esiste perche' nessuno la rimetta per sbaglio. Un commento che descrive la riga
// corretta aveva fatto fallire un test che cercava la stringa nel sorgente — il verso opposto del
// reperto D7, e altrettanto inutile.
// Toglie `//…` e `/*…*/` senza toccare il contenuto delle stringhe: un `'//'` dentro un'URL non
// deve mangiarsi il resto della riga.
const senzaCommenti = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((riga) => {
    let apice = null;
    for (let i = 0; i < riga.length; i++) {
      const c = riga[i];
      if (apice) { if (c === '\\') i++; else if (c === apice) apice = null; continue; }
      if (c === '"' || c === "'" || c === '`') { apice = c; continue; }
      if (c === '/' && riga[i + 1] === '/') return riga.slice(0, i);
    }
    return riga;
  })
  .join('\n');

console.log('\n══ 1 · IL GATE RESTA INTATTO: È UNA PROTEZIONE, NON UN INTRALCIO');
{
  const { evaluateManualGate } = require('./manual-order');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gest-manuale-'));
  const stateFile = path.join(dir, 'manual-mode.json');
  const MKT = '0x' + 'ab'.repeat(32);

  // Mercato NON in modalità manuale: il gate rifiuta, con il suo nome e il suo motivo.
  fs.writeFileSync(stateFile, JSON.stringify({ markets: {} }));
  const no = evaluateManualGate({ marketId: MKT }, { stateFile });
  ok('mercato non manuale ⇒ il gate NON permette', no.allow === false);
  ok('  col nome che l operatore vede', no.gate === 'manual-mode-inactive', String(no.gate));
  ok('  e il motivo che spiega perché esiste', /agent35 is still allowed to place and cancel/.test(no.reason));

  // Mercato in modalità manuale: passa, come sempre.
  fs.writeFileSync(stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { manual: true, at: 1, atIso: 'x', by: 'test', reason: 'test' } } }));
  const si = evaluateManualGate({ marketId: MKT }, { stateFile });
  ok('mercato manuale ⇒ il gate permette', si.allow === true && si.gate === null);

  // Stato illeggibile: fail closed, come prima. Non è diventato permissivo per far passare il flusso.
  fs.writeFileSync(stateFile, '{ questo non è json');
  const boh = evaluateManualGate({ marketId: MKT }, { stateFile });
  ok('stato illeggibile ⇒ si rifiuta comunque (fail closed)', boh.allow === false, String(boh.gate));
  ok('  e lo dice con un gate diverso, non lo confonde con «inattiva»',
    boh.gate === 'manual-mode-unreadable', String(boh.gate));

  // E il gate è ancora chiamato dal piazzamento, come PRIMO controllo.
  const mo = leggi('lib', 'maker', 'manual-order.js');
  ok('`placeManualOrder` chiama ancora il gate', /const gate = evaluateManualGate\(\{ marketId \}/.test(mo)
    || /evaluateManualGate\(\{ marketId \}/.test(mo));
  ok('  e `replaceManualOrder` pure', (mo.match(/evaluateManualGate\(/g) || []).length >= 2,
    `${(mo.match(/evaluateManualGate\(/g) || []).length} chiamate`);
}

console.log('\n══ 2 · LA CONFERMA A UN TOCCO ATTIVA LA GESTIONE MANUALE, E LO VERIFICA');
{
  // ═══ AGGIORNATO IL 6 AGOSTO 2026 ══════════════════════════════════════════════════════════════
  // La garanzia era: «un mercato non arriva al piazzamento senza che la proprietà manuale sia stata
  // presa E RILETTA». Prima viveva nella messa in coda del pannello. La coda non c'è più, e la
  // garanzia si è spostata dove ora si piazza: la rotta place-market. È il posto migliore — è dentro
  // la stessa transazione dell'ordine invece che in un passo separato che si poteva saltare.
  const r = leggi('app', 'api', 'maker', 'manual', 'place-market', 'route.ts');

  ok('la rotta legge se la gestione manuale è già attiva',
    /const proprieta = isManualMarket\(marketId\);/.test(r));
  ok('  e uno stato NON leggibile ferma tutto (fail closed)',
    /proprieta\.readable !== true/.test(r) && /proprieta-non-leggibile/.test(r),
    'manual:true con readable:false significa «non si è potuto stabilire», non «è già nostro»');
  ok('  e se non è attiva la prende, scrivendo davvero',
    /setManualMode\(\{ marketId, manual: true/.test(r));
  // Il motivo non nomina piu' la tab: con un profilo solo non ci sono due tab da distinguere.
  ok('  dichiarando nel motivo chi l ha fatto',
    /conferma a un tocco/.test(r));

  ok('LA VERIFICA è sul fatto RILETTO, non sull esito della scrittura',
    /gestione manuale · rilettura/.test(r)
    && /v\.readable === true && v\.manual === true/.test(r));
  ok('  e se la preparazione non riesce NON si piazza',
    /preparazione-fallita/.test(r) && /NESSUN ordine è stato inviato/.test(r));
  ok('  spiegando la conseguenza in italiano',
    /Un mercato preparato a metà è un rifiuto rimandato/.test(r));

  const corpo = r.slice(r.indexOf('export async function POST'));
  ok('e l attivazione avviene PRIMA del piazzamento',
    corpo.indexOf('setManualMode(') < corpo.indexOf('runBulkAllocation('),
    `manuale@${corpo.indexOf('setManualMode(')} < piazza@${corpo.indexOf('runBulkAllocation(')}`);
  ok('  e anche la rilettura avviene prima',
    corpo.indexOf('gestione manuale · rilettura') < corpo.indexOf('runBulkAllocation('));
}

console.log('\n══ 3 · GIÀ IN GESTIONE MANUALE ⇒ NIENTE DI DIVERSO DA OGGI');
{
  const r = leggi('app', 'api', 'maker', 'manual', 'place-market', 'route.ts');
  const corpo = r.slice(r.indexOf('export async function POST'));
  // La presa di proprietà sta dentro `if (pronto && !giaManuale)`: un mercato già manuale non fa
  // partire nessuna scrittura di modalità.
  ok('la scrittura della modalità è condizionata a «non è ancora manuale»',
    /if \(pronto && !giaManuale\) \{[\s\S]{0,600}setManualMode\(/.test(corpo));
  const scritture = (corpo.match(/setManualMode\(/g) || []).length;
  ok('  ed è UNA sola in tutto il percorso', scritture === 1, `${scritture}`);
  // L'anteprima non scrive niente: è il ramo che alimenta il dialog di conferma.
  ok('l anteprima esce PRIMA di qualunque scrittura',
    corpo.indexOf('if (preview) {') < corpo.indexOf('setAutoClose('),
    `anteprima@${corpo.indexOf('if (preview) {')} < scrittura@${corpo.indexOf('setAutoClose(')}`);

  const e = leggi('app', 'api', 'maker', 'markets', 'enable', 'route.ts');
  ok('e anche la route di abilitazione si guarda da sola: scrive solo se non era già manuale',
    /if \(takeManual && !manualBefore\.manual\) \{/.test(e));
}

console.log('\n══ 4 · IL RIEPILOGO PRIMA DELLA CONFERMA LO DICE');
{
  // Il riepilogo non è più il pannello della testa della coda: è il dialog di ConfermaEPiazza, che è
  // ora l'ULTIMA cosa che l'operatore legge prima che parta un ordine. La disclosure si è spostata lì.
  const c = leggi('app', 'components', 'ConfermaEPiazza.tsx');
  ok('il dialog dichiara la gestione manuale', /data-conferma-preparazione/.test(c));
  ok('  distinguendo «l ho preso io adesso» da «c era già»',
    /era già in gestione manuale/.test(c) && /passa ORA in gestione manuale/.test(c));
  ok('  e dicendo cosa comporta: agent35 non scrive più su quel libro',
    /agent35 non scriverà più su questo libro/.test(c));
  ok('  e che resta così finché non lo restituisci',
    /finché non lo restituisci/.test(c));
  ok('il bottone lo dice PRIMA di essere premuto, nel suo title',
    /agent35 non scriverà più su quel libro finché non lo restituisci/.test(c));
  ok('  e il riepilogo elenca le scritture che verranno fatte',
    /anteprima\.preparazione\.scritture\.join/.test(c));
}

console.log('\n══ 5 · IL PERCORSO SEPARATO PER ABILITARE UN MERCATO RESTA INTATTO');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('«1 · Anteprima» c è ancora', /1 · Anteprima/.test(p));
  ok('«2 · Conferma e aggiungi» c è ancora', /2 · Conferma e aggiungi/.test(p));
  ok('  e chiama lo stesso `addMarket` di prima', /onClick=\{\(\) => addMarket\(addPreview\.marketId, false/.test(p));
  ok('la spunta «prendi in gestione manuale» resta una scelta dell operatore',
    /const \[takeManual, setTakeManual\] = useState\(true\)/.test(p));
  // ── COSA GOVERNA OGGI QUELLA SPUNTA, DETTO ESPLICITAMENTE ──────────────────────────────────────
  // Prima governava DUE percorsi: l'abilitazione manuale di un mercato e l'ingresso in coda. La coda
  // non c'è più, e la conferma a un tocco NON la consulta: la rotta place-market prende la proprietà
  // come parte della preparazione, sempre.
  //
  // NON È UN AGGIRAMENTO, ed è la differenza che questo assert fissa: il percorso nuovo DICHIARA nel
  // dialog, prima del tap, che il mercato passa in gestione manuale e che ci resta. Una spunta che
  // spegne una scrittura dichiarata sarebbe un modo per arrivare al piazzamento senza la proprietà,
  // cioè un rifiuto rimandato al gate. La spunta continua a governare il percorso di abilitazione
  // («1 · Anteprima» / «2 · Conferma e aggiungi»), che è dove ha ancora un senso.
  ok('  la spunta governa ancora il percorso di abilitazione', /takeManual,/.test(p));
  const c = leggi('app', 'components', 'ConfermaEPiazza.tsx');
  ok('  e la conferma a un tocco non la aggira: dichiara la presa di proprietà nel dialog',
    !/takeManual/.test(c) && /passa ORA in gestione manuale/.test(c));
}

console.log('\n══ 6 · LA ROUTE VERIFICA LA SCRITTURA, E SI FERMA SE NON HA PRESO');
{
  const r = leggi('app', 'api', 'maker', 'markets', 'enable', 'route.ts');
  ok('dopo la scrittura rilegge con la funzione che il gate userà',
    /const dopo = isManualMarket\(id\);/.test(r));
  ok('  e il fermo scatta sull uno O sull altro', /if \(!manual\.ok \|\| !manualOra\) \{/.test(r));
  ok('  con un gate suo, non un ok:true silenzioso', /gate: 'manual-mode-write-failed'/.test(r));
  ok('  e uno stato HTTP che il pannello non può ignorare', /status: 409/.test(r));
  ok('  dicendo cosa resta scritto e cosa non è pronto',
    /Catalogo, uscita automatica e allowlist sono già scritti/.test(r));
  ok('la risposta riuscita porta il fatto RILETTO, non l esito della scrittura',
    /manualModeActive: manualOra,/.test(r));
  ok('  e un eccezione nella scrittura non passa per riuscita', /catch \(e\) \{\s*manual = \{ ok: false/.test(r));
}

console.log('\n══ 7 · IL PERCORSO IN BLOCCO: SENZA GESTIONE MANUALE NON SI PIAZZA');
(async () => {
  const { runAllocationReset } = require('./allocation-reset');
  const MKT = '0x' + 'cc'.repeat(32);
  const PIANO = [{ marketId: MKT, book: 'yes', price: 0.5, size: 100 }];
  const mondo = () => {
    const piazzati = [];
    const deps = {
      now: (() => { let t = 1_800_000_000_000; return () => (t += 10); })(),
      readEnabled: () => [],
      readTracking: () => [],
      listOrders: async () => ({ ok: true, simulated: false, orders: [] }),
      cancelOrder: async () => ({ ok: true }),
      setTrackingOff: async () => ({ ok: true }),
      setEnabled: async () => ({ ok: true }),
      setAutoClose: async () => ({ ok: true }),
      posizioneAperta: async () => ({ leggibile: true, aperta: false }),
      placeBulk: async ({ rows }) => { piazzati.push(...rows); return { ok: true, placed: rows.length, refused: 0, skipped: 0, results: [], totals: { rows: rows.length } }; },
      audit: () => {},
    };
    return { deps, piazzati };
  };

  // La scrittura della proprietà manuale FALLISCE ⇒ non si piazza niente.
  {
    const m = mondo();
    m.deps.setManual = async () => ({ ok: false, error: 'disco pieno' });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('gestione manuale fallita ⇒ NESSUN ordine piazzato', m.piazzati.length === 0, `${m.piazzati.length} piazzati`);
    ok('  e la sequenza si ferma dichiarandolo', r.stoppedBy === 'enable-failed', String(r.stoppedBy));
    ok('  nominando la gestione manuale fra le condizioni', /gestione manuale/.test(r.reason || ''), String(r.reason).slice(0, 80));
    ok('  e contando su quanti mercati manca', /Gestione manuale NON attiva su 1 mercato/.test(r.reason || ''));
    ok('  col motivo vero a verbale', /disco pieno/.test(JSON.stringify(r)));
  }
  // La dipendenza NON cablata è lo stesso caso: una decisione che nessuno può eseguire non è un permesso.
  {
    const m = mondo();
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('`setManual` non iniettata ⇒ NESSUN ordine piazzato', m.piazzati.length === 0, `${m.piazzati.length} piazzati`);
    ok('  e lo dice invece di tacere', /nessuna funzione setManual iniettata/.test(JSON.stringify(r)));
  }
  // Il caso normale: tutto riesce, e si piazza come prima.
  {
    const m = mondo();
    m.deps.setManual = async () => ({ ok: true, manual: true });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('con la gestione manuale attiva si piazza, come prima', r.stoppedBy == null, String(r.stoppedBy));
    ok('  una riga del piano, un piazzamento', m.piazzati.length === 1, `${m.piazzati.length}`);
    ok('  e il referto dice che quel mercato è manuale',
      (r.accensione?.markets || []).length > 0 && r.accensione.markets.every((x) => x.manual === true));
  }

  // E i due chiamanti veri la cablano.
  {
    const bulk = leggi('app', 'api', 'maker', 'manual', 'bulk-allocate', 'route.ts');
    ok('la route in blocco cabla `setManual`', /setManual: \(\{/.test(bulk));
    const a41 = leggi('agents', 'agent41-realloc-scheduler.js');
    ok('e il riallocatore periodico pure', /setManual: /.test(a41));
    // Qui, fino al 7 agosto 2026, si verificava che REALLOC_SCHEDULER_DRY_RUN fosse «ancora al suo
    // posto». Quella variabile è stata rimossa: il freno di agent41 adesso è `bot-enabled`, riletto a
    // ogni giro. L'assertion non è stata tolta, è stata PUNTATA SUL FRENO NUOVO — e vale di più di
    // prima, perché adesso pretende anche che il vecchio non sia tornato di soppiatto.
    ok('  col freno di agent41 ancora al suo posto: decide `bot-enabled`',
      /require\('\.\.\/lib\/maker\/bot-enabled'\)/.test(a41) && /botAttivo/.test(a41) && /statoBot\(\)/.test(a41));
    // Si vieta la LETTURA, non il nome: il commento che racconta la rimozione deve poter restare, ed è
    // anzi la ragione per cui fra sei mesi nessuno la rimetterà per sbaglio. Ciò che non deve tornare è
    // `process.env.REALLOC_SCHEDULER_DRY_RUN` in un ramo che decide qualcosa.
    ok('  e il vecchio interruttore d\'ambiente non viene più LETTO da nessuna parte',
      !/process\.env\.REALLOC_SCHEDULER_DRY_RUN/.test(senzaCommenti(a41)),
      'agent41 è tornato a leggere REALLOC_SCHEDULER_DRY_RUN');
    // ⚠ QUI NON SI GUARDA PIÙ IL TESTO, SI GUARDA L'OGGETTO. `ecosystem.config.js` è un modulo che
    // esporta `{ apps: [...] }`: caricarlo e chiedere a ogni app se dichiara quella chiave è una
    // prova, mentre una regex sul sorgente è un indizio che tre commenti bastavano a smentire.
    // Il filtro dei commenti resta comunque utile altrove, e per questo è definito una volta sola.
    const eco = require(path.join(ROOT, 'agents', 'ecosystem.config.js'));
    const conFreno = (eco.apps || []).filter((a) => a && a.env
      && Object.prototype.hasOwnProperty.call(a.env, 'REALLOC_SCHEDULER_DRY_RUN')).map((a) => a.name);

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // PERCHÉ QUESTO DIVIETO ESISTEVA — leggere PRIMA di reintrodurlo
    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // Fino al 7 agosto 2026 `REALLOC_SCHEDULER_DRY_RUN` era **il** freno di agent41, e questo test
    // vietava che tornasse in `ecosystem.config.js`. Il divieto non era pedanteria: nasceva da un
    // guasto vero, e la ragione vale ancora.
    //
    // ① **DUE INTERRUTTORI PER UNA DECISIONE SOLA SIGNIFICANO CHE SPEGNERNE UNO NON LA SPEGNE.**
    //    Il freno d'ambiente e AVVIA/FERMA rispondevano alla stessa domanda — «agent41 può piazzare?»
    //    — e chi metteva il bot su FERMA poteva credere di averlo fermato mentre l'altro diceva di sì,
    //    o viceversa. §2 lo dice per gli interruttori di stato, e vale identico qui.
    // ② **UN ENV SI LEGGE UNA VOLTA ALL'AVVIO.** `bot-enabled` si rilegge a ogni giro: FERMA vale dal
    //    ciclo dopo, senza riavvio. Un freno d'ambiente invece resta quello del momento in cui il
    //    processo è partito, e per cambiarlo servono due gesti (file + riavvio) — cioè esattamente i
    //    due gesti che in emergenza non si fanno.
    // ③ **E VIVEVA NELLA MEMORIA DI pm2, NON NEL FILE.** `pm2 restart --update-env` FONDE l'ambiente,
    //    non lo sostituisce: una variabile entrata una volta non se ne va cancellandola dal file. Per
    //    toglierla davvero serve `pm2 delete` + `pm2 start`. È §5.2 p.2, e la migrazione a `bot` l'ha
    //    ripulita solo perché pm2 è stato reinstallato da zero.
    //
    // ⚠⚠ COSA È CAMBIATO, E PERCHÉ L'ASSERZIONE ORA È UN'ALTRA — decisione dell'operatore, 18 agosto
    // 2026: «il freno a 0 nell'ecosystem lo voglio, è una mia scelta». Il conflitto è reale e la
    // decisione è sua. Ma le tre ragioni sopra NON sono state smentite, quindi il divieto non si
    // cancella: si **stringe** su ciò che resta pericoloso.
    //
    // Ciò che resta vietato è la ragione ①: che quella variabile torni a **DECIDERE**. Il test sopra
    // lo pretende già — `process.env.REALLOC_SCHEDULER_DRY_RUN` non compare in nessun ramo di agent41
    // — ed è quella l'asserzione che difende la proprietà. Dichiararla nell'`ecosystem` senza che
    // nessuno la legga non crea un secondo interruttore: crea una riga inerte, che `stato.js` mostra
    // come cintura APERTA e che quindi è visibile invece che nascosta.
    //
    // ⚠ E SE UN GIORNO QUALCUNO LA RICOLLEGA, il test sopra cade — non questo. Questo si limita a
    // pretendere che, se è dichiarata, sia dichiarata **solo su agent41**: su un altro processo non
    // avrebbe alcun significato, e sarebbe il primo passo verso il secondo interruttore.
    ok('  se è dichiarata in ecosystem.config.js, lo è SOLO su agent41 (dove il freno ha un senso)',
      conFreno.every((n) => n === 'agent41-realloc-scheduler'),
      `lo dichiarano: ${conFreno.join(', ') || '(nessuno)'}`);
    // ⚠ E il divieto vero — che torni a DECIDERE — resta due asserzioni più su, ed è quello che conta.
    // Questa riga esiste per ricordarlo a chi legge solo qui.
    ok('  e comunque NON viene letta da nessun ramo (è il divieto che conta, provato sopra)',
      !/process\.env\.REALLOC_SCHEDULER_DRY_RUN/.test(senzaCommenti(a41)));
  }

  console.log(`\ngestione manuale nel flusso: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

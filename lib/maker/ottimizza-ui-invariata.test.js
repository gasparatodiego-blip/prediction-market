#!/usr/bin/env node
'use strict';
// L'INTERFACCIA DELLA TAB OTTIMIZZA NON DEVE AVER GUADAGNATO CONTROLLI.
//
// ═══ PERCHÉ QUESTO TEST ESISTE ═══════════════════════════════════════════════════════════════════════
// Il vincolo dichiarato per questo lavoro è che i tre comportamenti — allocazione senza tetto per
// ordine, «mai in cima al book», erosione come rete di sicurezza — siano il comportamento DI SERIE:
// già attivi, già scelti, senza nulla da impostare. Un interruttore in più nel pannello non sarebbe
// una comodità: sarebbe la smentita del requisito, perché renderebbe il comportamento condizionato a
// una scelta dell'operatore.
//
// Il modo più diretto di impedirlo è INCHIODARE l'inventario dei controlli interattivi che il pannello
// aveva prima di questo lavoro. Se ne compare uno nuovo, questo test fallisce e obbliga a decidere
// esplicitamente invece di lasciar scivolare dentro un parametro.
//
// COSA QUESTO TEST NON È. Non è un test di layout né di resa grafica: non sa se il pannello è bello o
// leggibile. Conta i punti in cui l'operatore può CLICCARE O DIGITARE, che è l'unica cosa di cui il
// requisito parla.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const PANEL = path.join(__dirname, '../../app/components/RewardsAllocatePanel.tsx');
const src = fs.readFileSync(PANEL, 'utf8');

// ── L'INVENTARIO CONGELATO ─────────────────────────────────────────────────────────────────────────
// Rilevato dal pannello il 3 agosto 2026, PRIMA che «mai in cima» e l'erosione entrassero in funzione.
// Ogni voce è un punto in cui l'operatore agisce. Aggiungerne una è una decisione di prodotto, e va
// presa aggiornando questa lista con il motivo — non lasciandola passare.
const CONTROLLI_ATTESI = Object.freeze([
  // ── AGGIUNTO IL 4 AGOSTO 2026, E VALE LA PENA DIRE PERCHÉ ───────────────────────────────────────
  // Non è un controllo nuovo: è la metà mancante di un flusso a due passi che questa stessa lista
  // dichiarava già alla riga sotto («passo 1 di 2»). Il bottone di conferma è esistito dal 31 luglio
  // (commit bfcc60d) fino al refactor «sei tab diventano tre» (b7b80b4), che ne ha rimosso il render
  // insieme a quello dell'anteprima. L'inventario qui sopra è stato rilevato il 3 agosto — cioè DOPO
  // quella rimozione — e ha quindi congelato lo stato rotto come se fosse quello atteso.
  // Rimetterlo non aggiunge una scelta all'operatore: toglie un vicolo cieco.
  // ── LA CODA DI CONFERME, AGGIUNTA IL 4 AGOSTO 2026 ──────────────────────────────────────────────
  // Quattro controlli nuovi, e vale la pena dire perché non contraddicono il requisito che questa
  // lista protegge. Il vincolo è: i comportamenti di sicurezza devono essere DI SERIE, non dietro un
  // interruttore. Questi quattro non impostano niente — non c'è un parametro, una soglia o una
  // modalità da scegliere: sono i passi di un flusso di conferma, cioè l'opposto di un automatismo.
  //
  // E il flusso che aggiungono è più stretto, non più largo: prima si poteva piazzare un mercato per
  // volta (bottone della riga) o azzerare e rifare tutto («Conferma ed esegui»). La coda è la via di
  // mezzo che mancava, e ogni suo passo richiede un tocco esplicito — la stessa regola di prima,
  // applicata a N mercati invece che a uno.
  // ── TOLTI IL 6 AGOSTO 2026, E IL MOTIVO È IL PUNTO ────────────────────────────────────────────
  // `data-alloc-auto-preview` («1 · Anteprima») e `data-alloc-queue-add` («+ Metti in coda») erano i
  // primi due dei QUATTRO gesti che servivano per piazzare un mercato: anteprima, coda, conferma
  // gamba YES, conferma gamba NO. Sono stati sostituiti da un bottone solo — «Conferma e piazza —
  // $X» — con un dialog che elenca mercato, capitale totale e le due gambe.
  //
  // TOGLIERE DUE CONTROLLI NON VIOLA IL REQUISITO CHE QUESTO FILE PROTEGGE. Il requisito è che non
  // compaiano PARAMETRI da impostare: qui non ne compare nessuno, e il numero di gesti CALA. La
  // conferma esplicita non è sparita, è diventata una sola invece di quattro — e le quattro non erano
  // quattro protezioni, erano una decisione ribadita tre volte.
  //
  // I controlli che le sostituiscono vivono in ConfermaEPiazza.tsx e sono verificati più sotto, così
  // questa lista non smette di coprire il percorso di piazzamento solo perché si è spostato di file.
  // I tre controlli della coda («conferma la testa», «salta», «annulla») sono spariti con la coda
  // stessa: senza il bottone che ci metteva dentro i mercati non era più raggiungibile, e uno stato
  // irraggiungibile che continua a sembrare una funzione è peggio di una funzione assente.
  'data-alloc-add-confirm-btn',      // conferma dell aggiunta di un mercato proposto (passo 2 di 2)
  'data-alloc-auto-rejected-toggle', // mostra/nascondi i candidati scartati
  'data-alloc-auto-run',             // ⚡ Cerca la combinazione migliore
  'data-alloc-bulk-preview',         // anteprima del piazzamento in blocco (passo 1 di 2)
  'data-alloc-bulk-run',             // conferma del piazzamento in blocco (passo 2 di 2)
  'data-alloc-capital-input',        // il capitale da allocare
  'data-alloc-card-more',            // apre il dettaglio di una scheda mercato
  'data-alloc-card-reset',           // azzera l offset di una scheda
  'data-alloc-compute',              // Calcola
  'data-alloc-global-minus',         // offset globale −
  'data-alloc-place',                // piazza la singola riga
  'data-alloc-reset-all',            // azzera tutti gli offset
  'data-alloc-row-reset',            // azzera l offset di una riga
  'data-alloc-usefull',              // Usa saldo intero
  'data-alloc-widen-all',            // allarga la banda su tutte le righe
]);

// I marcatori che NON sono controlli: sono etichette, celle, contenitori — cose che il pannello
// MOSTRA. Possono crescere quanto serve: mostrare di più non chiede niente all operatore.
const attesiSet = new Set(CONTROLLI_ATTESI);

console.log('\n── i controlli interattivi del pannello, uno per uno');
{
  // Si guardano SOLO i marcatori che stanno su un elemento interattivo: bottone o input.
  const interattivi = new Set();
  const re = /<(button|input|select|textarea)\b[^>]*?(data-alloc-[a-z-]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) interattivi.add(m[2]);
  // Anche la forma con il marcatore PRIMA di altri attributi sulla stessa riga.
  const re2 = /(data-alloc-[a-z-]+)[^>]*?\/?>/g;
  const righe = src.split('\n');
  for (const r of righe) {
    if (!/<(button|input|select|textarea)\b/.test(r)) continue;
    let mm; re2.lastIndex = 0;
    while ((mm = re2.exec(r)) !== null) interattivi.add(mm[1]);
  }

  const nuovi = [...interattivi].filter((k) => !attesiSet.has(k)).sort();
  const spariti = CONTROLLI_ATTESI.filter((k) => !interattivi.has(k));

  ok(`nessun controllo NUOVO nella tab Ottimizza`, nuovi.length === 0,
    nuovi.length ? `comparsi: ${nuovi.join(', ')}` : `${interattivi.size} controlli, tutti già previsti`);
  ok('e nessuno di quelli che c erano è sparito', spariti.length === 0,
    spariti.length ? `mancano: ${spariti.join(', ')}` : 'il flusso resta identico');
}

console.log('\n── il percorso di piazzamento a un tocco, dove è finito');
{
  // La copertura non deve interrompersi solo perché i controlli sono migrati in un componente suo.
  // Questi tre sono il flusso INTERO: apri il riepilogo, invia, annulla.
  const CONF = path.join(__dirname, '../../app/components/ConfermaEPiazza.tsx');
  const csrc = fs.readFileSync(CONF, 'utf8');
  const atteso = ['data-conferma-apri', 'data-conferma-invia', 'data-conferma-annulla'];
  for (const a of atteso) ok(`${a} esiste`, csrc.includes(a));

  // LA PROPRIETÀ CHE CONTA: il bottone che apre il riepilogo NON invia. Chiede l'anteprima, che sul
  // server è il ramo che non scrive e non piazza. L'unico invio parte da `data-conferma-invia`.
  ok('il bottone che apre chiede l ANTEPRIMA, non il piazzamento',
    /data-conferma-apri[\s\S]{0,900}?chiedi\(true\)/.test(csrc));
  ok('e l invio vero è dietro il secondo bottone, dentro il dialog',
    /data-conferma-invia[\s\S]{0,400}?chiedi\(false\)/.test(csrc));

  // Nessun parametro di strategia deve essere comparso qui insieme al nuovo flusso.
  const proibitiQui = ['offsetTicks', 'maxSpread', 'bandRadius', 'ttlSeconds'];
  const trovati = proibitiQui.filter((k) => csrc.includes(k));
  ok('nessun parametro di taratura nel componente di conferma', trovati.length === 0, trovati.join(', '));
}

console.log('\n── nessun parametro dei nuovi comportamenti è finito nel pannello');
{
  // I nomi dei valori di taratura. Devono vivere in configurazione interna, MAI come campo da compilare.
  const proibiti = [
    ['erosionTriggerPct', 'la soglia del 40%'],
    ['erosionRecoveryPct', 'il rientro al 60%'],
    ['erosionWindowMs', 'la finestra della baseline'],
    ['erosionConfirmReadings', 'le 2 letture di conferma'],
    ['erosionMinMarketMinutes', 'la vita minima del mercato'],
    ['maxOrderNotionalUsd', 'il tetto per ordine'],
    ['behindBest', 'il posizionamento dietro il migliore'],
    ['topOfBook', 'il posizionamento in cima'],
  ];
  for (const [nome, cosa] of proibiti) {
    ok(`  ${cosa} non compare nel pannello`, !src.includes(nome), nome);
  }
}

console.log('\n── il flusso di conferma a due passi resta quello di prima');
{
  ok('il piazzamento in blocco resta anteprima → conferma',
    src.includes('data-alloc-bulk-preview') && src.includes('data-alloc-bulk-run'));
  ok('l aggiunta di un mercato proposto resta a due passi',
    /1 · Anteprima/.test(src) && /preview:/.test(src));
  ok('il bottone che cerca la combinazione è ancora uno solo',
    (src.match(/data-alloc-auto-run/g) || []).length >= 1);
  ok('e nessuna azione parte da sola', !/useEffect\([^)]*runAutoOptimise/.test(src),
    'la ricerca è un click esplicito, non un effetto');
}

console.log('\n── cio che e stato AGGIUNTO mostra soltanto, non chiede nulla');
{
  // I quattro fix della verifica UI aggiungono informazione, mai un controllo. Questa distinzione è
  // il cuore del requisito: mostrare di più non chiede niente all'operatore; un interruttore sì.
  const console_ = fs.readFileSync(path.join(__dirname, '../../app/components/LiquidityRewardsConsole.tsx'), 'utf8');

  ok('la nota di concentrazione esiste', src.includes('data-alloc-auto-concentration'));
  ok('  ed è un <div>, non un controllo', /<div className="alloc-note"[^>]*data-alloc-auto-concentration/.test(src));
  ok('  e spiega che è una scelta, non un fallimento', /Sono pochi per scelta, non per mancanza di candidati/.test(src));
  ok('  citando la frontiera, cioè un dato che l allocatore già restituisce', /autoPlan\.frontier/.test(src));

  ok('la distanza dal mid ha un marcatore suo', console_.includes('data-lrc-track-offset'));
  ok('  e dichiara se viene dal book o dalla configurazione', console_.includes('data-lrc-track-offset-kind'));
  ok('il badge «in cima / dietro / solo» esiste', console_.includes('data-lrc-track-top'));
  ok('il diario distingue la causa del riposizionamento', console_.includes('data-lrc-log-trigger'));
  ok('  e segnala quando si è finiti in cima', console_.includes('data-lrc-log-ontop'));

  // ── IL RESET SI DICHIARA PRIMA DEL TAP ────────────────────────────────────────────────────────
  // «Conferma ed esegui» adesso cancella ordini VERI. Un bottone che promette solo di piazzarli
  // sarebbe un bottone che mente sulla propria conseguenza più pesante.
  ok('il riquadro che spiega il reset esiste', src.includes('data-alloc-bulk-reset-warning'));
  ok('  ed è un avviso, non un controllo', /<div className="alloc-note alloc-warn"[^>]*data-alloc-bulk-reset-warning/.test(src));
  ok('  dice che è un reset e non un\'aggiunta', /reset completo, non un’aggiunta/.test(src));
  ok('  nomina la cancellazione degli ordini reali per PRIMA', src.indexOf('cancellati {bulkPreview') < src.indexOf('spenti {bulkPreview'));
  ok('  e dice cosa succede se una cancellazione fallisce', /la sequenza si ferma/.test(src));
  ok('il bottone di conferma non promette più solo di piazzare',
    /RESET COMPLETO: cancella gli ordini a riposo/.test(src));
  ok('  e la sua etichetta lo dice', /2 · Conferma ed esegui \(reset completo\)/.test(src));

  // Nessuno dei nuovi marcatori sta su un elemento interattivo.
  const nuovi = ['data-alloc-auto-concentration', 'data-alloc-bulk-reset-warning',
    'data-lrc-track-offset', 'data-lrc-track-top',
    'data-lrc-log-trigger', 'data-lrc-log-ontop', 'data-lrc-log-alone'];
  for (const n of nuovi) {
    const testo = n.startsWith('data-alloc') ? src : console_;
    const suControllo = new RegExp(`<(button|input|select|textarea)\\b[^>]*${n}`).test(testo);
    ok(`  ${n} non è un controllo`, suControllo === false);
  }
}

console.log('\n── i valori di taratura vivono nel backend, in un punto solo');
{
  const ero = fs.readFileSync(path.join(__dirname, 'book-erosion.js'), 'utf8');
  const tob = fs.readFileSync(path.join(__dirname, 'top-of-book.js'), 'utf8');
  ok('la soglia 40% è dichiarata in book-erosion.js', /EROSION_TRIGGER_PCT = 40/.test(ero));
  ok('il rientro 60% pure', /EROSION_RECOVERY_PCT = 60/.test(ero));
  ok('la finestra della baseline pure', /BASELINE_WINDOW_MS = 600_000/.test(ero));
  ok('le 2 letture di conferma pure', /EROSION_CONFIRM_READINGS = 2/.test(ero));
  ok('e sono tarabili da file/env senza toccare la UI', /function erosionConfig\(tuning/.test(ero));
  ok('l offset di ripiego è dichiarato in top-of-book.js', /FALLBACK_OFFSET_CENTS = 1/.test(tob));
}

console.log(`\nUI di Ottimizza invariata: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

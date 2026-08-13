#!/usr/bin/env node
'use strict';
// IL TRIGGER A CAPITALE FERMO — QUANDO SCATTA, DOVE MANDA IL CAPITALE, E COSA NON PUÒ FARE.
//
// Le proprietà che contano:
//   1. sotto soglia non succede NIENTE — nessun rumore, nessuna lettura del venue, nessun ordine;
//   2. non scatta mai a bot FERMO, e non scatta mai sopra un ciclo già in corso (il lucchetto);
//   3. un saldo non leggibile non è un saldo basso e non è un saldo alto: non si piazza;
//   4. il capitale va dove il PIANO lo voleva e adesso non c'è — non su un mercato inventato;
//   5. se non c'è spazio, non si forza: il capitale resta liquido;
//   6. il mini-ciclo non conosce la cancellazione — provato leggendo il sorgente di agent41.

const fs = require('fs');
const path = require('path');
const T = require('./trigger-capitale-fermo');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const ROOT = path.resolve(__dirname, '..', '..');
const saldo = (usd) => ({ readable: true, usd });
const base = { abilitato: true, botAttivo: true, cicloInCorso: false, now: 1_000_000_000 };

console.log('\n══ 1 · QUANDO SCATTA, E QUANDO STA ZITTO');
{
  const d = T.decidiTrigger({ ...base, saldo: saldo(120) });
  ok(`sopra la soglia di $${T.SOGLIA_USD} scatta`, d.scatta === true, d.motivo);
  ok('  e dichiara quanto capitale è fermo', d.eccedenzaUsd === 120);

  ok('sotto soglia NON scatta', T.decidiTrigger({ ...base, saldo: saldo(49.99) }).scatta === false);
  ok('  esattamente ALLA soglia scatta: $50 è «almeno $50»', T.decidiTrigger({ ...base, saldo: saldo(50) }).scatta === true);
  ok('  e il motivo dice il numero, non «sotto soglia» e basta',
    /49\.99/.test(T.decidiTrigger({ ...base, saldo: saldo(49.99) }).motivo));
}

console.log('\n══ 2 · I CANCELLI: BOT FERMO, LUCCHETTO, SALDO ILLEGGIBILE');
{
  ok('a bot FERMO non scatta MAI, nemmeno con $10.000 liquidi',
    T.decidiTrigger({ ...base, botAttivo: false, saldo: saldo(10_000) }).scatta === false);
  ok('  ed è lo stesso interruttore del ciclo fisso, non un secondo',
    /FERMO/.test(T.decidiTrigger({ ...base, botAttivo: false, saldo: saldo(10_000) }).motivo));
  ok('con un ciclo GIÀ IN CORSO non si sovrappone: è lo stesso capitale',
    T.decidiTrigger({ ...base, cicloInCorso: true, saldo: saldo(500) }).scatta === false);
  ok('spento esplicitamente non scatta', T.decidiTrigger({ ...base, abilitato: false, saldo: saldo(500) }).scatta === false);

  for (const [nome, s] of [
    ['saldo mai letto', null],
    ['RPC irraggiungibile', { readable: false, error: 'RPC non raggiungibile' }],
    ['saldo stantio', { readable: false, error: 'saldo stantio (300s)' }],
    ['saldo NaN', { readable: true, usd: NaN }],
  ]) {
    ok(`${nome} ⇒ non si piazza: un'incognita non è uno zero e non è un via libera`,
      T.decidiTrigger({ ...base, saldo: s }).scatta === false);
  }
}

console.log('\n══ 3 · LE DUE ATTESE: QUIETE DOPO UN CICLO, COOLDOWN FRA DUE TRIGGER');
{
  const ora = base.now;
  ok('subito dopo un ciclo completo si aspetta: il saldo si sta ancora assestando',
    T.decidiTrigger({ ...base, saldo: saldo(500), ultimoCicloAt: ora - 10_000 }).scatta === false);
  ok('  passata la quiete, scatta',
    T.decidiTrigger({ ...base, saldo: saldo(500), ultimoCicloAt: ora - T.QUIETE_DOPO_CICLO_MS - 1 }).scatta === true);
  ok('subito dopo un mini-ciclo si aspetta il cooldown: senza, un guasto si riproverebbe ogni 2 min',
    T.decidiTrigger({ ...base, saldo: saldo(500), ultimoTriggerAt: ora - 60_000 }).scatta === false);
  ok('  passato il cooldown, scatta di nuovo',
    T.decidiTrigger({ ...base, saldo: saldo(500), ultimoTriggerAt: ora - T.COOLDOWN_MS - 1 }).scatta === true);
}

console.log('\n══ 4 · DOVE VA IL CAPITALE: DOVE IL PIANO LO VOLEVA E ADESSO NON C È');
{
  const riga = (id, capital, rendimento, over = {}) => ({
    marketId: id, capital, realisticBestPerDay: rendimento, mid: 0.5, tick: 0.01,
    pairCostUsd: 0.98, minSizeShares: 20, computedDefaultOffsetTicks: 1, ...over,
  });
  const righe = [riga('0xA', 130, 5), riga('0xB', 130, 9), riga('0xC', 130, 1)];

  // B rende di più, ma è pieno; A è vuoto. Il capitale va dove c'è SPAZIO, non dove il numero è alto.
  const s = T.scegliMercato({ righe, disponibileUsd: 100, notionalePerMercato: { '0xb': 130 } });
  ok('il mercato migliore ma PIENO viene saltato', s.riga && s.riga.marketId === '0xA', s.riga && s.riga.marketId);
  ok('  e si alloca solo quello che ci sta', s.allocatoUsd === 100);
  ok('  la riga consegnata è quella del piano, col solo capitale riscritto',
    s.riga.tick === 0.01 && s.riga.computedDefaultOffsetTicks === 1 && s.riga.capital === 100);
  ok('  e le share per lato sono ricalcolate col costo della coppia, non ereditate',
    Math.abs(s.riga.sizePerSideShares - 100 / 0.98) < 1e-9, `${s.riga.sizePerSideShares.toFixed(2)} share`);

  // Con tutti pieni non si forza: il capitale resta liquido.
  const pieno = T.scegliMercato({ righe, disponibileUsd: 100, notionalePerMercato: { '0xa': 130, '0xb': 130, '0xc': 130 } });
  ok('tutti i mercati pieni ⇒ nessun piazzamento forzato, il capitale resta liquido', pieno.riga === null);
  ok('  e si dice perché, mercato per mercato', pieno.esaminate.length === 3 && /nessuno spazio/.test(pieno.esaminate[0].motivo));

  // Uno spazio piccolo non è un'occasione: sotto il minimo non si spolvera.
  const briciole = T.scegliMercato({ righe, disponibileUsd: 100, notionalePerMercato: { '0xa': 120, '0xb': 120, '0xc': 120 } });
  ok(`spazio da $10, sotto il minimo di $${T.MIN_ALLOCAZIONE_USD} ⇒ non si piazza`, briciole.riga === null);

  // Il tetto di concentrazione resta quello del piano, anche qui.
  const capato = T.scegliMercato({ righe, disponibileUsd: 500, notionalePerMercato: {}, capPerMercatoUsd: 60 });
  ok('il tetto per mercato morde anche nel mini-ciclo', capato.allocatoUsd === 60, `$${capato.allocatoUsd}`);

  // La size minima del venue è un gate duro: sotto, il venue non assegna punteggio.
  const sottoMin = T.scegliMercato({ righe: [riga('0xD', 130, 9, { minSizeShares: 5000 })], disponibileUsd: 100, notionalePerMercato: {} });
  ok('sotto la size minima del venue non si piazza: quel capitale maturerebbe zero', sottoMin.riga === null);
  ok('  col motivo che nomina il minimo', /minimo del venue/.test(sottoMin.esaminate[0].motivo));

  ok('un piano vuoto non produce un piazzamento inventato', T.scegliMercato({ righe: [], disponibileUsd: 500 }).riga === null);
}

console.log('\n══ 5 · IL NOZIONALE A RIPOSO, DAGLI ORDINI VERI');
{
  const n = T.notionalePerMercato([
    { marketId: '0xA', price: 0.5, size: 100 },
    { marketId: '0xa', price: 0.25, sizeRemaining: 40, size: 100 },
    { marketId: '0xB', price: 0.9, size: 10 },
    { marketId: '0xC', price: null, size: 10 },
  ]);
  ok('le due gambe dello stesso mercato si sommano, e l id non è sensibile al maiuscolo', n['0xa'] === 60);
  ok('  si usa la size RESIDUA quando c è: un ordine mezzo eseguito immobilizza meno', n['0xa'] === 0.5 * 100 + 0.25 * 40);
  ok('un ordine con prezzo illeggibile non viene contato come zero: viene saltato', n['0xc'] === undefined);
}

console.log('\n══ 6 · SIMULAZIONE: UN MERGE LIBERA CAPITALE E IL MINI-CICLO LO RIMETTE AL LAVORO');
{
  // Lo scenario chiesto, a capitale finto: il piano teneva $130 su tre mercati; una chiusura ha
  // svuotato 0xB e lasciato $120 liquidi. Nessun ordine viene toccato: si aggiunge solo su 0xB.
  const righe = [
    { marketId: '0xA', capital: 130, realisticBestPerDay: 4, mid: 0.5, tick: 0.01, pairCostUsd: 0.98, minSizeShares: 20, computedDefaultOffsetTicks: 1 },
    { marketId: '0xB', capital: 130, realisticBestPerDay: 7, mid: 0.5, tick: 0.01, pairCostUsd: 0.98, minSizeShares: 20, computedDefaultOffsetTicks: 1 },
  ];
  const ordiniVivi = [
    { marketId: '0xA', price: 0.5, size: 130 },        // A è pieno
    { marketId: '0xMANUALE', price: 0.4, size: 50 },   // un ordine messo a mano, su un mercato fuori piano
  ];
  const perMercato = T.notionalePerMercato(ordiniVivi);
  const d = T.decidiTrigger({ ...base, saldo: saldo(120) });
  ok('con $120 liquidi il trigger scatta', d.scatta === true);
  const s = T.scegliMercato({ righe, disponibileUsd: d.eccedenzaUsd, notionalePerMercato: perMercato });
  ok('  e il capitale va su 0xB, il mercato svuotato', s.riga.marketId === '0xB');
  ok('  per $120, cioè tutto il liquido (sotto il suo tetto di piano da $130)', s.allocatoUsd === 120);
  ok('  il mercato messo a mano non compare fra i candidati: non è nel piano',
    !s.esaminate.some((x) => x.marketId === '0xMANUALE') && s.riga.marketId !== '0xMANUALE');
  ok('  e A non viene nemmeno esaminato: il migliore CON SPAZIO vince subito, senza scorrere il resto',
    s.esaminate.length === 0, 'B rende di più di A ed è vuoto, quindi la ricerca finisce lì');

  // E il giro dopo, con il capitale ormai al lavoro, non succede più niente.
  const dopo = T.decidiTrigger({ ...base, saldo: saldo(0), ultimoTriggerAt: base.now - T.COOLDOWN_MS - 1 });
  ok('speso il liquido, il trigger si spegne da solo: nessun rumore', dopo.scatta === false);
}

console.log('\n══ 7 · IL MINI-CICLO NON CONOSCE LA CANCELLAZIONE — PROVA SUL SORGENTE');
{
  const src = fs.readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  const i = src.indexOf('async function miniCiclo');
  const j = src.indexOf('// ── IL TIMER');
  ok('la funzione del mini-ciclo si trova', i > 0 && j > i);
  const corpo = src.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('il mini-ciclo NON chiama la corsia di cancellazione',
    !/cancelManualOrder\s*\(/.test(corpo),
    'l unica cancellazione raggiungibile è quella che ritira una gamba orfana, e vive nel cablaggio condiviso');
  ok('  non spegne il tracking', !/setTracking/.test(corpo));

  // ── QUESTA ASSERZIONE È CAMBIATA L'8 AGOSTO 2026, ED È IL PUNTO DI UNA CORREZIONE ───────────────
  // Diceva «non cambia la modalità manuale, non tocca l auto-close». Era vero, ed era il difetto: il
  // gate 1 di `placeManualOrder` (`manual-mode-inactive`) esige che il mercato sia in gestione manuale
  // PRIMA di ricevere ordini, e il mini-ciclo non lo prendeva mai. Finché sceglieva dal piano salvato
  // non si vedeva — li aveva già preparati il reset — ma dal momento in cui RICALCOLA sceglie mercati
  // nuovi, e allora ogni gamba veniva rifiutata: 5 mercati, 5 rifiuti, 0 ordini.
  //
  // La proprietà giusta non è «non tocca», è ASIMMETRICA: il mini-ciclo può PRENDERE un mercato in
  // gestione e ACCENDERGLI l'uscita, mai il contrario. Rilasciare un mercato o spegnere una via
  // d'uscita sono azioni del ciclo delle sei ore, che ha il quadro completo; questo giro no.
  ok('  prende i mercati nuovi in gestione (è la precondizione del gate, non un suo aggiramento)',
    /setManualMode\(\{ marketId, manual,/.test(corpo) && /preparaMercatoNuovo\(/.test(corpo));
  ok('  e accende l uscita automatica PRIMA che il mercato abbia ordini',
    /setAutoClose\(\{ scope: 'market', marketId, enabled,/.test(corpo));
  // ── LA TERZA SCRITTURA, AGGIUNTA DOPO UNA MISURA SUI DATI VIVI ────────────────────────────────
  // La prima stesura la ometteva: la allowlist di auto-reprice governa `MAKER_MODE=live-min`, e il
  // processo di agent41 ha `MAKER_MODE=off`. Ma la corsia manuale costruisce l'adapter con
  // `mode: 'live-min'` CABLATO (manual-order.js:733), quindi quel gate si applica lo stesso. Col fix
  // a due scritture `manual-mode-inactive` spariva e ogni gamba moriva un gradino dopo, su
  // `live-min-market-mismatch`. L'ambiente di un processo non dice quale modalità una corsia CHIEDE.
  ok('  e abilita il mercato, perché la corsia manuale chiede live-min a prescindere dall env',
    /setAutoReprice\(\{ scope: 'market', marketId, enabled,/.test(corpo));

  const prep = src.slice(src.indexOf('async function preparaMercatoNuovo'), src.indexOf('async function miniCiclo'));
  // ⚠ L'asserzione cercava `enabled: false` in TUTTO il corpo e dal 13 agosto 2026 prendeva anche
  // `impostaBot({ enabled: false })` — l'ultimo gradino della scala di sblocco, che mette il BOT su
  // FERMA. È un'altra cosa: la proprietà difesa qui è «il mini-ciclo acquisisce mercati, non li
  // rilascia», e riguarda le tre scritture PER MERCATO. Spegnere l'interruttore globale in emergenza è
  // esattamente ciò che fa anche `agent43-guardian`, ed è una decisione di sicurezza, non un rilascio.
  // Adesso si guardano le tre chiamate per nome invece del testo grezzo: più stretto, e non prende un
  // meccanismo diverso solo perché usa le stesse due parole.
  const scrittureDiMercato = (corpo.match(/set(AutoReprice|ManualMode|AutoClose)\([^)]*\)/g) || []).join(' | ');
  ok('  ma SOLO in acquisizione: mai `manual:false`, mai `enabled:false` sulle scritture PER MERCATO',
    /manual: true/.test(prep) && /enabled: true/.test(prep)
      && !/manual: false/.test(prep) && !/enabled: false/.test(prep)
      && !/manual: false|enabled: false/.test(scrittureDiMercato),
    'rilasciare un mercato, spegnere una via d uscita o disabilitare restano del ciclo delle sei ore');
  // Ogni `enabled: false` del file deve appartenere a uno dei due meccanismi che hanno il diritto di
  // spegnere qualcosa, e sono entrambi FUORI dal mini-ciclo: il tracking del ciclo da sei ore, e il
  // fermo di sicurezza dell'ultimo gradino. Un terzo va guardato con attenzione, ed è per questo che
  // il test lo fa cadere invece di contarli e basta.
  ok('  e ogni `enabled: false` del file appartiene a un meccanismo dichiarato',
    (() => {
      const righe = src.split('\n').filter((l) => /enabled: false/.test(l) && !/^\s*(\*|\/\/)/.test(l));
      return righe.length > 0 && righe.every((l) => /setTracking\(|impostaBot\(/.test(l));
    })(),
    'solo `setTracking` (ciclo 6h) e `impostaBot` (fermo di sicurezza) possono spegnere');
  ok('  e una scrittura fallita FERMA quel mercato invece di piazzarci sopra',
    /if \(!\(en && en\.ok\)\)/.test(prep) && /if \(!\(mn && mn\.ok\)\)/.test(prep) && /if \(!\(ac && ac\.ok\)\)/.test(prep));
  ok('  e non ricalcola il piano: è tutto il punto del trigger',
    !/calcolaPiano|RUNNER_PIANO/.test(corpo));
  // Gli effetti sono iniettabili (serve a poter simulare QUESTA funzione, non una sua copia), quindi
  // la proprietà da verificare non è «chiama X» ma «il DIFETTO è X»: un iniettabile col difetto
  // sbagliato sarebbe un buco che nessuna simulazione vedrebbe.
  ok('il difetto del piano è quello SALVATO, non un ricalcolo', /deps\.leggiPiano \|\| leggiUltimoPiano/.test(corpo));
  ok('il difetto del piazzamento è la corsia vera', /deps\.piazza \|\| piazzaCoppia/.test(corpo));
  ok('il difetto degli ordini è la lettura vera del venue', /deps\.listOrders \|\| \(\(\) => listManualOrders/.test(corpo));
  ok('costruisce le gambe con la STESSA funzione del piano e del pannello', /gambeDiUnaRiga\s*\(/.test(corpo));
  ok('e timbra gli ordini come automatici, così il ciclo delle sei ore li riconoscerà come propri',
    /origine: 'auto'/.test(src));

  // Il lucchetto condiviso: il controllo periodico e il ciclo fisso usano LA STESSA variabile.
  const ctrl = src.slice(src.indexOf('async function controlloCapitaleFermo'), src.indexOf('// ── IL TIMER'));
  ok('il controllo periodico condivide il lucchetto `inCorso` col ciclo fisso',
    /if \(inCorso\) return/.test(ctrl) && /inCorso = true/.test(ctrl) && /inCorso = false/.test(ctrl));
  ok('  e lo rilascia SEMPRE, anche se il mini-ciclo esplode', /finally \{ inCorso = false; \}/.test(ctrl));
}


// ══ LA CADENZA OPERATIVA CONTRO QUELLA DELLA SCOPERTA (8 agosto 2026, sera) ══════════════════════
// Il requisito è una DISUGUAGLIANZA, non un numero: il trigger deve poter agire più spesso di quanto
// la scoperta riscriva il board. Verificarla contro il sorgente di agent24 invece che contro una
// costante copiata è l'unico modo perché non si rompa in silenzio se un domani si cambia una delle due.
{
  const fsCad = require('fs');
  const pathCad = require('path');
  const T = require('./trigger-capitale-fermo');
  const srcA24 = fsCad.readFileSync(pathCad.join(__dirname, '..', '..', 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  const m = srcA24.match(/SCAN_INTERVAL_MS\s*=\s*(\d+)\s*\*\s*60_?000/);
  const scopertaMin = m ? Number(m[1]) : null;
  ok('la cadenza della scoperta si legge dal sorgente di agent24', scopertaMin === 15, `${scopertaMin} min`);
  ok('la cadenza OPERATIVA del trigger è 10 minuti', T.CADENZA_OPERATIVA_MS === 600_000, `${T.CADENZA_OPERATIVA_MS / 60000} min`);
  ok('  ed è lo stesso numero del cooldown (un solo orologio, non due)', T.COOLDOWN_MS === T.CADENZA_OPERATIVA_MS);
  ok('IL TRIGGER AGISCE PIÙ SPESSO DELLA SCOPERTA', T.CADENZA_OPERATIVA_MS < scopertaMin * 60_000,
    `${T.CADENZA_OPERATIVA_MS / 60000} min < ${scopertaMin} min`);
  ok('  e la RILEVAZIONE resta più fitta dell\'azione: guardare non è agire',
    T.CADENZA_MS < T.CADENZA_OPERATIVA_MS, `${T.CADENZA_MS / 1000}s vs ${T.CADENZA_OPERATIVA_MS / 1000}s`);
  ok('  la lettura del saldo non è più fitta della sua cache (TTL 45s)', T.CADENZA_MS >= 45_000);
}

console.log(`\ntrigger capitale fermo: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
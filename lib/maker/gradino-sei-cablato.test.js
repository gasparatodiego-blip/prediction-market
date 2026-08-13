#!/usr/bin/env node
'use strict';
// IL GRADINO 6 ESISTE DAVVERO, E IL GRADINO 5 SI SA LEGGERE.
//
// ═══ PERCHÉ QUESTO FILE ══════════════════════════════════════════════════════════════════════════════
// `agents/agent41-realloc-scheduler.js` chiamava `impostaBot(...)` nel gradino «fermati-in-sicurezza»
// senza averlo importato da `lib/maker/bot-enabled`: la destrutturazione si fermava a
// `registraMercatoAperto`. Il `try` che avvolge l'esecutore catturava il ReferenceError e lo
// trasformava in un esito ordinario — `azione fallita: impostaBot is not defined` — quindi la scala
// arrivava in fondo, dichiarava di essersi fermata, e il bot restava su AVVIA.
//
// Falliva CHIUSO, cioè senza rischio di capitale. Ma la difesa di ultima istanza NON ESISTEVA, e
// nessun test poteva accorgersene: `bot-enabled.test.js` provava che la funzione funziona, non che
// qualcuno la chiami; i test su agent41 provavano i gradini 1-5, che invece erano cablati.
// È la sesta occorrenza della classe «dep non cablata» di §5.3 — un identificatore mancante non è un
// errore rumoroso, è un valore che nessuno ha chiesto.
//
// ═══ COSA SI DIFENDE, E COME ═════════════════════════════════════════════════════════════════════════
// Non si fotografa il sorgente (§5.3: un test che fotografa il codice è verde in lavorazione e rosso
// dopo il commit). Si difendono tre PROPRIETÀ:
//   §1 · ogni funzione di `bot-enabled` che agent41 CHIAMA è anche una che agent41 IMPORTA — la
//        proprietà generale, che copre la classe intera e non solo `impostaBot`;
//   §2 · il gradino 6, ESEGUITO, chiama davvero l'interruttore e non solleva ReferenceError;
//   §3 · il messaggio del gradino 5 riporta un NUMERO e non un array di oggetti.
//
// ═══ LA CINTURA SULLO STATO VERO ═════════════════════════════════════════════════════════════════════
// §2 esegue il ramo che mette il bot su FERMA. Lo fa contro una SPIA installata nel modulo prima che
// agent41 lo destrutturi, quindi `data/maker-bot-enabled.json` non viene mai aperto in scrittura — ma
// «non dovrebbe» non è una prova: il file vero viene fotografato prima e riletto dopo, e il test
// FALLISCE se è cambiato di un byte. Il 7 agosto 2026 una versione del test del guardiano ha lasciato
// residui sullo stato vero (§5 punto 1): quella lezione si paga una volta sola.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const AGENT41 = path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js');

// ── LA FOTOGRAFIA DELLO STATO VERO, PRIMA DI TOCCARE QUALUNQUE COSA ─────────────────────────────────
const BOT_ENABLED = require('./bot-enabled');
const FILE_VERO = BOT_ENABLED.FILE;
const primaBytes = fs.existsSync(FILE_VERO) ? fs.readFileSync(FILE_VERO) : null;
const primaMtime = fs.existsSync(FILE_VERO) ? fs.statSync(FILE_VERO).mtimeMs : null;

console.log('\n══ 1 · IL CABLAGGIO — chi si chiama si importa');
{
  // Si toglie ciò che non è codice: un identificatore citato in un commento o dentro una stringa non
  // è una chiamata, e un test strutturale che non filtra i commenti è già stato ingannato in questo
  // repo (§5.3). Le stringhe contano quanto i commenti: `'impostaBot is not defined'` è testo.
  const grezzo = fs.readFileSync(AGENT41, 'utf8');
  const codice = grezzo
    .replace(/\/\*[\s\S]*?\*\//g, ' ')            // commenti a blocco
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')        // commenti di riga (senza mangiare `https://`)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')     // template literal
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")   // stringhe singole
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');  // stringhe doppie

  // Cosa `bot-enabled` mette a disposizione, letto dal modulo e non da un elenco ricopiato: se domani
  // nasce una funzione nuova, questo test la considera senza che nessuno lo aggiorni.
  const esportate = Object.keys(BOT_ENABLED).filter((k) => typeof BOT_ENABLED[k] === 'function');
  ok('bot-enabled esporta impostaBot', esportate.includes('impostaBot'), esportate.join(', '));

  // Cosa agent41 destrutturà da bot-enabled.
  const m = codice.match(/const\s*\{([^}]*)\}\s*=\s*require\(\s*''\s*\)/g) || [];
  const rigaImport = (grezzo.match(/const\s*\{([^}]*)\}\s*=\s*require\('\.\.\/lib\/maker\/bot-enabled'\)/) || [])[1] || '';
  const importate = new Set(rigaImport.split(',').map((s) => s.split(':')[0].trim()).filter(Boolean));
  ok('agent41 destruttura da bot-enabled', importate.size > 0, [...importate].join(', '));

  // Chi viene CHIAMATO nel codice vero.
  const chiamate = esportate.filter((f) => new RegExp('(?<![\\w.$])' + f + '\\s*\\(').test(codice));
  ok('  e il codice chiama almeno una di quelle funzioni', chiamate.length > 0, chiamate.join(', '));

  // ⇒ LA PROPRIETÀ. Non «impostaBot è importato», ma «non esiste una chiamata senza filo».
  const scoperte = chiamate.filter((f) => !importate.has(f));
  ok('NESSUNA funzione di bot-enabled è chiamata senza essere importata',
    scoperte.length === 0, scoperte.length ? 'SCOPERTE: ' + scoperte.join(', ') : 'tutte cablate');

  // La metà opposta, che la proprietà da sola non copre: se domani qualcuno togliesse la chiamata
  // invece di aggiungere l'import, il sottoinsieme resterebbe valido e il gradino 6 sparirebbe in
  // silenzio. Quindi si pretende che la chiamata ci sia.
  ok('  e il gradino 6 chiama davvero l\'interruttore', chiamate.includes('impostaBot'));
  ok('  con lo spegnimento esplicito', /impostaBot\(\s*\{\s*enabled:\s*false/.test(codice));
  void m;
}

console.log('\n══ 2 · IL GRADINO 6, ESEGUITO — nessun ReferenceError, e l\'interruttore viene chiamato');
{
  // LA SPIA va installata PRIMA di richiedere agent41: la destrutturazione avviene al `require`, quindi
  // ciò che agent41 cattura è la funzione presente in quell'istante. Sostituendola qui, il ramo del
  // gradino 6 gira per intero senza che `data/maker-bot-enabled.json` venga mai aperto in scrittura.
  //
  // ⚠ E LA SPIA NON MASCHERA IL DIFETTO CHE STIAMO CERCANDO, che è il punto delicato. Se `impostaBot`
  // non fosse nella destrutturazione, l'identificatore nel gradino 6 resterebbe non definito nello
  // scope del modulo e la chiamata solleverebbe ReferenceError comunque — la spia vive nell'oggetto
  // esportato, non nello scope di agent41. Il test distingue quindi i due mondi davvero.
  const chiamate = [];
  const vera = BOT_ENABLED.impostaBot;
  BOT_ENABLED.impostaBot = (arg) => { chiamate.push(arg); return { ok: true, prima: true, ora: false, stato: {} }; };

  let A41 = null, err = null;
  try { A41 = require(AGENT41); } catch (e) { err = e; }
  ok('agent41 si carica senza eseguire il ciclo', !!A41 && !err, err ? err.message : 'require.main !== module');

  if (A41) {
    const esito = require('util').promisify((cb) => {
      A41.eseguiGradino('fermati-in-sicurezza').then((r) => cb(null, r), (e) => cb(e));
    });
    const run = async () => {
      let r = null, e2 = null;
      try { r = await esito(); } catch (e) { e2 = e; }
      ok('il gradino 6 non solleva', !e2, e2 ? e2.message : 'nessuna eccezione propagata');
      ok('  e riporta ok:true', !!(r && r.ok === true), r ? JSON.stringify(r.dettaglio) : 'nessun esito');
      // La prova che il difetto è andato: il vecchio codice tornava esattamente questa stringa.
      ok('  NON riporta più «impostaBot is not defined»',
        !!(r && !/impostaBot is not defined/.test(String(r.dettaglio || ''))));
      ok('  e l\'interruttore è stato chiamato una volta', chiamate.length === 1, 'chiamate=' + chiamate.length);
      ok('  chiedendo lo spegnimento, non l\'accensione', chiamate[0] && chiamate[0].enabled === false);
      ok('  dichiarando chi è stato', /agent41/.test(String((chiamate[0] || {}).by || '')), (chiamate[0] || {}).by);
      ok('  e perché', String((chiamate[0] || {}).reason || '').length > 20);

      BOT_ENABLED.impostaBot = vera;

      // ── LA CINTURA ───────────────────────────────────────────────────────────────────────────────
      const dopoBytes = fs.existsSync(FILE_VERO) ? fs.readFileSync(FILE_VERO) : null;
      const dopoMtime = fs.existsSync(FILE_VERO) ? fs.statSync(FILE_VERO).mtimeMs : null;
      ok('L\'INTERRUTTORE VERO NON È STATO TOCCATO — contenuto',
        (primaBytes === null && dopoBytes === null) || (primaBytes && dopoBytes && primaBytes.equals(dopoBytes)));
      ok('  né la data di modifica', primaMtime === dopoMtime, `${primaMtime} → ${dopoMtime}`);

      chiudi();
    };
    run();
  } else { BOT_ENABLED.impostaBot = vera; chiudi(); }
}

function terzaSezione() {
  console.log('\n══ 3 · IL GRADINO 5 — un numero, non sessanta [object Object]');
  const A41 = require(AGENT41);
  const f = A41.messaggioFeedRiseminato;
  ok('la formattazione è una funzione esportata, non un\'interpolazione sepolta', typeof f === 'function');
  if (typeof f !== 'function') return;

  // La forma VERA del valore di ritorno di `writeCollectorPriority`: `mercati` sono le voci (oggetti),
  // `marketIds` gli id. È la divergenza che ha prodotto il difetto.
  const finto = {
    ok: true,
    marketIds: Array.from({ length: 60 }, (_, i) => '0x' + String(i).padStart(64, '0')),
    mercati: Array.from({ length: 60 }, (_, i) => ({ id: '0x' + String(i).padStart(64, '0'), motivo: 'piano', rank: i })),
  };
  const msg = f(finto);
  ok('un piano da 60 mercati si legge come 60', /\b60 mercati\b/.test(msg), msg);
  ok('  e non contiene [object Object]', !/\[object Object\]/.test(msg));
  ok('  né una virgola per ogni voce', (msg.match(/,/g) || []).length === 0);

  // ⚠ La regressione vera: contare da `mercati` darebbe lo stesso numero e sembrerebbe corretto. Si
  // pretende che il conteggio venga da `marketIds`, come nel ciclo normale — se i due divergono, è
  // `marketIds` a comandare, perché è quello che agent34 sottoscriverà.
  const divergente = { ok: true, marketIds: ['a', 'b', 'c'], mercati: [{ id: 'a' }, { id: 'b' }] };
  ok('il conteggio viene da marketIds, non da mercati', /\b3 mercati\b/.test(f(divergente)), f(divergente));

  ok('zero mercati si legge come zero', /\b0 mercati\b/.test(f({ ok: true, marketIds: [], mercati: [] })));

  // §5.3 · `Number(null) === 0`: l'assenza non può travestirsi da misura.
  ok('un conteggio ILLEGGIBILE non diventa 0', !/\b0 mercati\b/.test(f(null)), f(null));
  ok('  e lo dichiara', /non leggibile/.test(f(null)));
  ok('  lo stesso se manca il campo', /non leggibile/.test(f({ ok: true, mercati: [{ id: 'a' }] })));
}

function chiudi() {
  terzaSezione();
  console.log(`\ngradino-sei-cablato: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
}

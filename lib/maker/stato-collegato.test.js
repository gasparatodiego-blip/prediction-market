#!/usr/bin/env node
'use strict';
// NESSUNO STATO SI SCRIVE SENZA CHE QUALCUNO LO LEGGA.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Gemello di dipendenze-collegate.test.js, sull'altro lato dell'applicazione. Là si prova che ogni
// `deps.X` invocato in lib/ abbia un iniettore; qui che ogni stato React scritto venga anche letto.
//
// È la stessa classe di difetto — costruito e mai collegato — e produce il sintomo più difficile da
// diagnosticare che ci sia, perché somiglia a un successo:
//
//     premi il bottone → entra in caricamento → la richiesta parte → la risposta torna →
//     il bottone si riprende → E NON SUCCEDE NIENTE.
//
// Nessun pannello, nessun errore, nessuna traccia. Anche il ramo di fallimento è muto, perché di norma
// `setErr` è scrivi-e-basta esattamente come tutti gli altri.
//
// ═══ IL CASO VERO ════════════════════════════════════════════════════════════════════════════════════
// 4 agosto 2026: «1 · Anteprima» nella tab Ottimizza non mostrava nulla da quattro giorni. Il pannello
// esisteva ed era scritto bene; il refactor «sei tab diventano tre» (b7b80b4, 31 luglio) aveva tolto le
// venti righe che lo rendevano e lasciato in piedi lo stato, il bottone e la chiamata. Tre stati
// diventati scrivi-e-basta in un colpo solo: addPreview, addResult, addErr.
// Lo stesso controllo, girato la prima volta, ne ha trovati altri tre in OrderPanel — fra cui `acMsg`,
// che teneva l'esito del toggle della chiusura automatica: un rifiuto sulla via d'uscita di una
// posizione spariva senza lasciare traccia sullo schermo.

const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const SCANNER = path.join(ROOT, 'scripts', 'stato-non-letto.js');
const analisi = require(SCANNER);
const fs = require('fs');

console.log('\n══ OGNI STATO SCRITTO VIENE LETTO DA QUALCUNO');
{
  ok('nessuno stato scritto e mai letto in app/',
    analisi.morti.length === 0,
    analisi.morti.length
      ? analisi.morti.map((m) => `${m.nome} (${m.file}:${m.riga})`).join(' · ')
      : `${analisi.vivi.length} stati vivi`);

  ok('nessuno stato inerte (né scritto né letto)',
    analisi.inerti.length === 0,
    analisi.inerti.length ? analisi.inerti.map((m) => m.nome).join(' · ') : 'nessuno');
}

console.log('\n══ IL CASO CHE HA FATTO NASCERE IL CONTROLLO, RIMESSO IN PIEDI');
{
  const src = fs.readFileSync(path.join(ROOT, 'app', 'components', 'RewardsAllocatePanel.tsx'), 'utf8');
  ok('l anteprima viene RENDERIZZATA, non solo richiesta', /addPreview && addPreview\.summary/.test(src),
    'senza questa riga la risposta arriva e non la vede nessuno');
  ok('  e sta dentro la scheda del mercato a cui si riferisce',
    /stessoMercato\(addPreview\.marketId, c\.marketId\)/.test(src));
  ok('  il passo 2 esiste: senza conferma l anteprima è un vicolo cieco',
    /2 · Conferma e aggiungi/.test(src) && /addMarket\(addPreview\.marketId, false\)/.test(src));
  ok('  l esito della conferma si vede', /addResult && addResult\.ok/.test(src));
  ok('L ERRORE SI VEDE — «nemmeno un messaggio di errore» era metà del sintomo',
    /\{addErr && \(/.test(src) && /data-alloc-add-error/.test(src));
  ok('  il confronto fra id è insensibile al maiuscolo (la route normalizza, il board no)',
    /a\.toLowerCase\(\) === b\.toLowerCase\(\)/.test(src));

  const op = fs.readFileSync(path.join(ROOT, 'app', 'components', 'OrderPanel.tsx'), 'utf8');
  ok('l esito del toggle della chiusura automatica si vede',
    /\{acMsg && </.test(op) && /data-op-qs-ac-msg/.test(op),
    'un rifiuto sulla via d uscita di una posizione non deve essere muto');
}

console.log('\n══ E IL CONTROLLO PRENDE DAVVERO IL DIFETTO PER CUI È NATO');
{
  // La prova che un controllo del genere deve dare di sé: che FALLISCA quando deve. Si ricostruisce la
  // forma esatta del difetto — uno stato scritto dalla risposta di una fetch, e mai letto nel JSX.
  const difettoso = [
    "export function Pannello() {",
    "  const [anteprima, setAnteprima] = useState(null);",
    "  const [errore, setErrore] = useState(null);",
    "  const [aperto, setAperto] = useState(false);",
    "  const chiedi = async () => {",
    "    try {",
    "      const r = await fetch('/api/x');",
    "      setAnteprima(await r.json());",
    "    } catch (e) { setErrore(e.message); }",
    "  };",
    "  return <div>{aperto ? 'si' : 'no'}<button onClick={chiedi}>vai</button></div>;",
    "}",
  ].join('\n');
  const res = analisi.analizzaSorgente(difettoso, 'finto.tsx');
  const per = (nome) => res.find((r) => r.nome === nome);

  ok('lo stato scritto dalla risposta e mai letto è MORTO', per('anteprima') && per('anteprima').classe === 'morto',
    per('anteprima') && `${per('anteprima').scritture}w/${per('anteprima').letture}r`);
  ok('  e anche il ramo di errore, che è la metà che fa più male',
    per('errore') && per('errore').classe === 'morto');
  ok('  mentre lo stato letto nel JSX è vivo', per('aperto') && per('aperto').classe === 'vivo');
  ok('  il referto dice DOVE viene scritto, per poterlo aprire subito',
    per('anteprima').doveScritto.length > 0 && /setAnteprima/.test(per('anteprima').doveScritto[0].testo));

  // Lo stesso codice, con una sola riga in più: la lettura. Deve tornare tutto vivo.
  const corretto = difettoso.replace(
    "  return <div>{aperto ? 'si' : 'no'}",
    "  return <div>{anteprima && <pre>{anteprima.x}</pre>}{errore && <b>{errore}</b>}{aperto ? 'si' : 'no'}",
  );
  const res2 = analisi.analizzaSorgente(corretto, 'finto.tsx');
  ok('AGGIUNTA LA SOLA LETTURA, non resta nessun morto',
    res2.every((r) => r.classe === 'vivo'), res2.map((r) => `${r.nome}:${r.classe}`).join(' '));

  // Un setter chiamato NON conta come lettura del proprio stato: è il confine su cui l'euristica vive
  // o muore, perché `setAnteprima` contiene «Anteprima».
  const soloSetter = "const [v, setV] = useState(0);\nsetV(1);\nreturn <b>ciao</b>;";
  const res3 = analisi.analizzaSorgente(soloSetter, 'finto.tsx');
  ok('chiamare setV non conta come leggere v', res3[0] && res3[0].classe === 'morto',
    res3[0] && `${res3[0].scritture}w/${res3[0].letture}r`);

  // Una lettura dentro un commento non è una lettura.
  const inCommento = "const [v, setV] = useState(0);\nsetV(1);\n// qui un giorno mostreremo v\nreturn <b>ciao</b>;";
  ok('una menzione in un commento non salva lo stato',
    analisi.analizzaSorgente(inCommento, 'finto.tsx')[0].classe === 'morto');

  // IL FALSO NEGATIVO CHE LO SCANNER HA PRODOTTO SU SE STESSO: un blocco `/* … */` le cui righe di
  // continuazione non cominciano con `*` passava per codice, e il commento che SPIEGAVA il difetto
  // teneva in vita i nomi che il difetto aveva ucciso. È il caso più insidioso, perché più il commento
  // è utile più è probabile che nomini la variabile.
  const inBlocco = [
    "const [v, setV] = useState(0);",
    "setV(1);",
    "/* Questo blocco un giorno mostrerà v:",
    "   e qui si parla ancora di v, senza asterisco a inizio riga. */",
    "return <b>ciao</b>;",
  ].join('\n');
  ok('un blocco /* … */ senza asterischi non salva lo stato',
    analisi.analizzaSorgente(inBlocco, 'finto.tsx')[0].classe === 'morto',
    'è il falso negativo che questo scanner ha prodotto su se stesso');

  ok('  ma il codice DOPO la chiusura del blocco viene ancora visto', (() => {
    const dopo = "const [v, setV] = useState(0);\nsetV(1);\n/* niente */\nreturn <b>{v}</b>;";
    return analisi.analizzaSorgente(dopo, 'finto.tsx')[0].classe === 'vivo';
  })());

  ok('  e un // dentro una stringa di URL non mangia la riga', (() => {
    const url = "const [v, setV] = useState(0);\nsetV(1);\nfetch('https://x.dev/api');\nreturn <b>{v}</b>;";
    return analisi.analizzaSorgente(url, 'finto.tsx')[0].classe === 'vivo';
  })());

  // Falso positivo da evitare: uno stato letto SOLO in un effetto o in una dipendenza è vivo lo stesso.
  const soloEffetto = "const [v, setV] = useState(0);\nsetV(1);\nuseEffect(() => { console.log(v); }, [v]);\nreturn <b>ciao</b>;";
  ok('letto solo dentro un effetto → vivo (il controllo cerca i MAI letti, non discute come)',
    analisi.analizzaSorgente(soloEffetto, 'finto.tsx')[0].classe === 'vivo');
}

console.log(`\nstato collegato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

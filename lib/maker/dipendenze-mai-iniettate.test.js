'use strict';
// lib/maker/dipendenze-mai-iniettate.test.js — L'INVENTARIO DI TUTTE LE DEP CHE NESSUNO INIETTA.
//
// ═══ PERCHÉ ESISTE, E PERCHÉ NON BASTAVA `dipendenze-collegate` ══════════════════════════════════════
// `scripts/dipendenze-scollegate.js` classifica ogni `deps.X` di `lib/` in quattro categorie, e
// `dipendenze-collegate.test.js` fallisce su DUE:
//   · **morte**   — facoltative (guardate, senza ramo alternativo) che nessuno inietta ⇒ il blocco non
//                   entra MAI e nessuno lo dice;
//   · **orfane**  — obbligatorie senza ripiego che nessuno inietta ⇒ esploderebbero.
//
// Restava fuori la terza, ed è la più numerosa: **con ripiego, e mai iniettata da nessuno**. Il 18
// agosto 2026 erano **44**, e nessun test le nominava. Non sono un guasto — il ripiego fa la cosa
// giusta — ma sono cuciture che il repo CONTA come vive mentre nessuno le usa, ed è esattamente la
// forma con cui `resolveOwnOrders` è rimasta scollegata: dichiarata, guardata, con un commento che
// spiegava a chi serviva, e mai passata da nessuno. Costava una lettura del venue per ogni gamba.
//
// ⚠ È LA QUINTA VOLTA CHE QUESTA CLASSE COSTA CARA in questo repo: `readDepth` non iniettato (il
// Livello 1 del merge non valutabile), `signerProvider` non cablato (il merge on-chain che non ha mai
// firmato), `{file}` invece di `{auditFile}`, `deps.stato` con `||` invece di `!== undefined`, e
// `resolveOwnOrders`. Ogni volta il test unitario era verde: provava la decisione, non il cablaggio.
//
// ═══ COSA PRETENDE QUESTO TEST ══════════════════════════════════════════════════════════════════════
// Che **ogni** dep mai iniettata sia o (a) iniettata da qualcuno, o (b) **dichiarata qui** con una
// ragione. Non chiede di collegarle tutte: chiede che nessuna resti mai-iniettata **in silenzio**.
// Aggiungerne una nuova senza dichiararla fa cadere questo test, che è tutto il punto.
//
// ⚠ NON È UN ELENCO DI ESENZIONI. Una voce dell'inventario dice «so che nessuno la inietta, e va bene
// perché…». Il giorno in cui una di queste diventa la sesta occorrenza, la sua riga è già lì a dire
// che qualcuno ci aveva pensato — o a smentirlo.

const path = require('path');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const sez = (t) => console.log(`\n── ${t} ──`);

const ROOT = path.resolve(__dirname, '..', '..');
const analisi = require(path.join(ROOT, 'scripts', 'dipendenze-scollegate.js'));

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// L'INVENTARIO — ogni dep mai iniettata, con la ragione per cui va bene così
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Le famiglie non sono un modo di non guardare: sono il modo di dire la ragione UNA volta invece di
// quarantaquattro, e ogni nome resta scritto per esteso. Chi ne aggiunge uno deve scegliere la sua
// famiglia, e se non ne trova una probabilmente ha appena scritto una cucitura morta.

const INVENTARIO = [
  {
    famiglia: 'percorso di file',
    perche: 'seam per far scrivere i test in una directory temporanea invece che nel `data/` di '
      + 'produzione. NON collegarla è il comportamento voluto: in produzione il percorso vero è il '
      + 'difetto. È la cucitura che il 18 agosto 2026 è servita davvero, quando il test del kill '
      + 'giornaliero aveva depositato una richiesta finta nel `data/` vero.',
    nomi: ['allocatedCapitalFile', 'boardFile', 'cancellazioniFile', 'capsFile', 'confrontoFile',
      'fillStrategyAuditFile', 'fillStrategyConfigFile', 'normFile', 'registroResiduiFile',
      'residuiFile', 'scadenzeFile', 'statoFile', 'dataDir', 'runtimeDir'],
  },
  {
    famiglia: 'primitiva di sistema',
    perche: 'seam per COSTRUIRE un guasto nei test — un `mkdir` che fallisce, un disco pieno, un '
      + 'orologio che non avanza. In produzione la primitiva vera è il difetto, e sostituirla sarebbe '
      + 'il guasto. `percorsi-critici.test.js` le usa tutte per fabbricare i suoi quindici scenari.',
    nomi: ['accessSync', 'mkdirSync', 'renameSync', 'statSync', 'writeFileSync', 'readdirSync',
      'stderr', 'sleep'],
  },
  {
    famiglia: 'sacca di sotto-dipendenze',
    perche: 'non è una dipendenza: è il contenitore che un chiamante userebbe per passarne altre più '
      + 'in giù. Vuoto significa «uso i difetti», che è il caso normale. Resta perché senza di lui un '
      + 'test non potrebbe raggiungere il livello sotto senza riscrivere quello sopra.',
    nomi: ['auditDeps', 'autoCloseDeps', 'autoRepriceDeps', 'chiusuraDeps', 'killDeps', 'limitDeps',
      'manualDeps', 'offsetDeps', 'trackingDeps'],
  },
  {
    famiglia: 'funzione pura sostituibile',
    perche: 'il difetto è la funzione VERA della produzione, importata dal suo modulo. La cucitura '
      + 'serve a un test per far rispondere quella funzione in modo controllato senza costruirle '
      + 'attorno tutto lo scenario. Collegarla in produzione significherebbe passare la stessa '
      + 'funzione che il difetto già usa — cioè una riga che non cambia niente.',
    nomi: ['controlloMaiPrimo', 'trovaLivello', 'pavimentoDepth', 'conScomposizione', 'daMercati',
      'getPubblico', 'finestraH', 'getJson', 'cancelledByUs', 'rinnoviSegnalati'],
  },
  {
    famiglia: 'manopola di attesa del relayer',
    perche: 'quanti tentativi e con che passo si aspetta la conferma on-chain. Il difetto è tarato sui '
      + 'tempi veri della catena; la cucitura esiste perché un test non può aspettare quei tempi. '
      + '⚠ Se un giorno servisse cambiarli in produzione, il posto è la costante, non questa dep.',
    nomi: ['passoConfermaMs', 'tentativiConferma'],
  },
  {
    famiglia: 'manopola di freschezza',
    perche: 'per quanto tempo una lettura depositata resta valida. Il difetto è tarato su un fatto '
      + 'del mondo — `ENTRY_MAX_AGE_MS` sta sopra la GTD di 23 minuti, così la valvola non può mai '
      + 'accorciare la vita di un ordine ancora vivo — e la cucitura esiste solo perché un test non '
      + 'può aspettare mezz\'ora per vedere una voce scadere. ⚠ Collegarla in produzione sarebbe un '
      + 'errore, non un miglioramento: renderebbe configurabile una soglia che difende il perimetro, '
      + 'e il posto per cambiarla resta la costante, dove il test ne asserisce la RELAZIONE con la GTD.',
    nomi: ['entryMaxAgeMs'],
  },
  {
    famiglia: 'superficie on-chain',
    perche: '`mergeOnChain` ha come difetto il relayer VERO (`ctf-relayer`), che è cablato e firma '
      + 'davvero — §4.9. La cucitura serve ai test per non toccare la catena. ⚠ È la dep più delicata '
      + 'dell\'inventario: la sua gemella `signerProvider` è già stata la seconda occorrenza di questa '
      + 'classe, e il merge on-chain non ha firmato per giorni. Qui il difetto è vivo, e un test lo prova.',
    nomi: ['mergeOnChain'],
  },
];

const DICHIARATE = new Map();
for (const f of INVENTARIO) for (const n of f.nomi) DICHIARATE.set(n, f);

// ══ ① NESSUNA DEP MORTA O ORFANA ═══════════════════════════════════════════════════════════════════
sez('① le due categorie che restano un errore');
{
  ok('nessuna dipendenza FACOLTATIVA senza iniettore in un modulo vivo',
    analisi.morte.length === 0,
    analisi.morte.map((m) => `deps.${m.nome} in ${m.usataIn.join(',')}`).join(' · '));
  ok('nessuna dipendenza OBBLIGATORIA senza iniettore in un modulo vivo',
    analisi.orfane.length === 0,
    analisi.orfane.map((m) => `deps.${m.nome}`).join(' · '));
}

// ══ ② OGNI DEP MAI INIETTATA È DICHIARATA ══════════════════════════════════════════════════════════
sez('② ogni dep mai iniettata è nell\'inventario, con una ragione');
{
  const maiIniettate = analisi.altre
    .filter((m) => !Array.isArray(m.iniettataIn) || m.iniettataIn.length === 0)
    .map((m) => m.nome)
    .sort();

  const senzaRagione = maiIniettate.filter((n) => !DICHIARATE.has(n));
  ok(`tutte le ${maiIniettate.length} dep mai iniettate sono dichiarate`,
    senzaRagione.length === 0,
    senzaRagione.length ? `SENZA RAGIONE: ${senzaRagione.join(', ')}` : '');

  // ⚠ E IL VERSO OPPOSTO, che è quello che fa invecchiare gli inventari: una voce che descrive una dep
  // che non esiste più. Senza questa asserzione l'elenco cresce e non si accorcia mai, e fra sei mesi
  // nessuno sa quali righe descrivano ancora qualcosa.
  const tutte = new Set(analisi.altre.map((m) => m.nome)
    .concat(analisi.morte.map((m) => m.nome), analisi.orfane.map((m) => m.nome)));
  const fantasmi = [...DICHIARATE.keys()].filter((n) => !tutte.has(n));
  ok('nessuna voce dell\'inventario descrive una dep che non esiste più',
    fantasmi.length === 0, fantasmi.join(', '));

  // ⚠ E una voce che descrive una dep ORA COLLEGATA va tolta, o l'inventario dice che nessuno la
  // inietta mentre qualcuno la inietta.
  const collegateMaDichiarate = analisi.altre
    .filter((m) => Array.isArray(m.iniettataIn) && m.iniettataIn.length > 0 && DICHIARATE.has(m.nome))
    .map((m) => m.nome);
  ok('nessuna voce dell\'inventario descrive una dep che INVECE è iniettata',
    collegateMaDichiarate.length === 0, collegateMaDichiarate.join(', '));

  console.log(`\n   inventario: ${DICHIARATE.size} dep dichiarate in ${INVENTARIO.length} famiglie`);
  for (const f of INVENTARIO) {
    const vive = f.nomi.filter((n) => maiIniettate.includes(n));
    console.log(`     · ${f.famiglia.padEnd(28)} ${String(vive.length).padStart(2)} dep`);
  }
}

// ══ ③ OGNI FAMIGLIA HA UNA RAGIONE VERA, NON UN'ETICHETTA ══════════════════════════════════════════
sez('③ l\'inventario spiega, non elenca soltanto');
{
  for (const f of INVENTARIO) {
    ok(`«${f.famiglia}» ha una ragione scritta`, typeof f.perche === 'string' && f.perche.length > 80,
      `${(f.perche || '').length} caratteri`);
    ok(`  e almeno un nome`, Array.isArray(f.nomi) && f.nomi.length > 0);
  }
  // ⚠ NESSUN NOME IN DUE FAMIGLIE: sarebbe due ragioni per la stessa cosa, cioè nessuna.
  const visti = new Set(); const doppi = [];
  for (const f of INVENTARIO) for (const n of f.nomi) { if (visti.has(n)) doppi.push(n); visti.add(n); }
  ok('nessun nome compare in due famiglie', doppi.length === 0, doppi.join(', '));
}

// ══ ④ IL CASO CHE HA FATTO NASCERE QUESTO TEST ═════════════════════════════════════════════════════
sez('④ `resolveOwnOrders` è collegata, e non può tornare morta in silenzio');
{
  const r = analisi.altre.concat(analisi.morte, analisi.orfane).find((m) => m.nome === 'resolveOwnOrders');
  ok('`resolveOwnOrders` esiste ancora fra le dep analizzate', !!r);
  ok('  ed è INIETTATA da qualcuno', !!r && Array.isArray(r.iniettataIn) && r.iniettataIn.length > 0,
    r ? `iniettata in: ${(r.iniettataIn || []).join(', ') || 'NESSUNO'}` : '');
  ok('  e NON è nell\'inventario delle mai-iniettate', !DICHIARATE.has('resolveOwnOrders'));
}

console.log(`\ndipendenze mai iniettate: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

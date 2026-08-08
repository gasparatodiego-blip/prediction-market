'use strict';
// lib/audit/rilevatori.js — I RILEVATORI DELL'AUDIT DI SCOPERTA. PURI, E SENZA I/O.
//
// ═══ COSA SONO ═══════════════════════════════════════════════════════════════════════════════════════
// Ogni funzione qui dentro prende una FOTOGRAFIA del codice (una mappa `percorso → contenuto`, già
// letta da chi chiama) e restituisce un elenco di reperti. Nessuna legge il disco, nessuna scrive, e
// nessuna chiama la rete: l'I/O sta tutto in agents/agent44-audit-scoperta.js.
//
// Non è pedanteria: un rilevatore che legge da sé sarebbe impossibile da provare senza allestire un
// finto repo, e finirebbe non provato. Così ogni regola si prova con tre righe di stringa.
//
// ═══ DA DOVE VENGONO QUESTE REGOLE ══════════════════════════════════════════════════════════════════
// Non da una lista di buone pratiche: dai guasti VERI trovati in questo progetto fra il 3 e l'8 agosto
// 2026. Ognuna porta il caso che l'ha generata, perché una regola senza il suo incidente è una regola
// che nessuno sa più perché esiste.
//
//   D1 · costanti dello stesso concetto con valori diversi   → il tetto 20% nel motore contro 30% nel
//        pianificatore (7 agosto): il vincolo più stretto vinceva, ma il piano proponeva righe che il
//        quoting tagliava.
//   D2 · protezione presente su un percorso e assente su un altro → la regola di fine scala viveva su
//        due percorsi su quattro; `ownOrders` era passato solo da agent40 e il pannello si accodava a
//        se stesso.
//   D3 · la stima che diverge dal consuntivo → misurata l'8 agosto: stima $3,09 contro $1,3042 reali.
//   D4 · flag che nessuno legge più ma restano nell'ambiente → REALLOC_SCHEDULER_DRY_RUN.
//   D5 · test rossi persistenti, e la distinzione fra vecchi noti e nuovi.
//   D6 · collisioni di numerazione → agent42-guardian contro agent42-watch-makers.
//   D7 · un COMMENTO che dichiara un valore diverso da quello importato → `MIN_HORIZON_DAYS = 2`
//        scritto in risk-classifier.js mentre il valore vero è 0,25, e proprio su un modulo la cui
//        intestazione promette che le due cose non possano divergere. Trovato l'8 agosto.
//
// ═══ SEVERITÀ ═══════════════════════════════════════════════════════════════════════════════════════
// 'alta'  = può cambiare cosa il bot fa col capitale, o nasconde un dato sbagliato dietro uno giusto.
// 'media' = incoerenza reale che oggi non morde, ma morderà appena qualcuno si fida della riga sbagliata.
// 'bassa' = disordine: nessun effetto oggi, ma costa tempo a chi legge.

const IGNORA = /(^|\/)(node_modules|\.next|\.next-verifica|\.git|public|prisma\/migrations)(\/|$)/;
const SORGENTE = /\.(js|ts|tsx|mjs)$/;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Un reperto, nella forma che la coda sa archiviare. `id` è la sua impronta: stabile fra scansioni. */
function reperto({ id, regola, severita, dove, titolo, dettaglio }) {
  return { id, regola, severita, dove, titolo, dettaglio };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D1 · LA STESSA COSTANTE, DUE VALORI
//
// Due forme, e la seconda è quella che ha morso davvero:
//   (a) lo STESSO identificatore dichiarato con valori diversi in file diversi;
//   (b) un CONCETTO che vive sotto nomi diversi — qui serve una tabella, perché nessuna euristica sa
//       che `MARKET_CAP_PCT` e `CONCENTRATION_CAP_FRAC` sono lo stesso tetto. La tabella è curata a
//       mano e va allungata quando se ne scopre un altro: è documentazione eseguibile, non magia.
const CONCETTI = [
  {
    nome: 'tetto di concentrazione per mercato',
    nomi: ['MARKET_CAP_PCT', 'CONCENTRATION_CAP_FRAC'],
    nota: 'il tetto di capitale per singolo mercato. Il 7 agosto 2026 valeva 0,20 nel motore e 0,30 nel pianificatore: il vincolo più stretto vinceva comunque, ma il piano proponeva righe che il quoting poi tagliava.',
  },
  {
    nome: 'quota massima credibile',
    nomi: ['maxCredibleShare', 'MAX_CREDIBLE_SHARE'],
    nota: 'il tetto oltre il quale una quota modellata descrive un book che non esiste. Deve essere UNO: se l\'obiettivo del knapsack e la stima realistica ne usassero due, sceglierebbero e giudicherebbero con metri diversi.',
  },
  {
    nome: 'orizzonte minimo di risoluzione',
    nomi: ['MIN_HORIZON_DAYS'],
    nota: 'il minimo di vita residua che un mercato deve avere per entrare nel piano.',
  },
  {
    nome: 'freschezza del dato di piano',
    nomi: ['STALE_S', 'STALE_SECONDS'],
    nota: '«dato troppo vecchio» — la stessa soglia che esclude una riga dai totali e che etichetta una card.',
  },
];

/** `const NOME = <numero>` — la forma con cui questo repo dichiara le sue soglie. */
const DICHIARAZIONE = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*[;,\n]/g;
/** `nome: <numero>` dentro un oggetto di difetti (es. DEFAULTS di realistic-estimate). */
const CAMPO = /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*[,\n]/g;

function costantiNumeriche(file, contenuto) {
  const out = [];
  for (const re of [DICHIARAZIONE, CAMPO]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(contenuto))) {
      const riga = contenuto.slice(0, m.index).split('\n').length + 1;
      out.push({ file, nome: m[1], valore: Number(m[2]), riga });
    }
  }
  return out;
}

function rilevaCostantiDivergenti(fotografia) {
  const trovate = [];
  for (const [file, testo] of fotografia) {
    if (!SORGENTE.test(file) || /\.test\.(js|ts)$/.test(file)) continue;
    trovate.push(...costantiNumeriche(file, testo));
  }
  const out = [];

  // (a) stesso nome, valori diversi
  const perNome = new Map();
  for (const c of trovate) {
    if (!perNome.has(c.nome)) perNome.set(c.nome, []);
    perNome.get(c.nome).push(c);
  }
  // DOVE questa euristica vale, e dove sarebbe solo rumore. Due agent indipendenti che hanno ciascuno
  // il proprio `MAX_RPS` non stanno dicendo due cose diverse sulla stessa grandezza: stanno dicendo due
  // cose su due grandezze omonime. Il caso che vale è quello DENTRO LO STESSO SOTTOSISTEMA — due moduli
  // di `lib/maker/` che non sono d'accordo su una soglia sono due versioni di una regola sola.
  // Misurato all'introduzione: senza questa restrizione il rilevatore produceva 14 reperti, tutti
  // omonimie fra agent indipendenti. Un report che si legge è un report che non contiene quei 14.
  // E vale solo dentro `lib/`: `agents/` sono quaranta programmi indipendenti, e raggrupparli tutti in
  // un solo «sottosistema» rimetteva dentro esattamente il rumore che questa restrizione toglie.
  const sottosistema = (f) => { const m = /^(lib\/[^/]+)\//.exec(f); return m ? m[1] : null; };
  for (const [nome, elenco] of perNome) {
    // Solo nomi che SEMBRANO una soglia condivisa: MAIUSCOLE_CON_UNDERSCORE. Un `i = 0` locale non è
    // una costante di dominio, e segnalarlo sarebbe rumore che fa smettere di leggere il report.
    if (!/^[A-Z][A-Z0-9_]{3,}$/.test(nome)) continue;
    const perSotto = new Map();
    for (const e of elenco) {
      const k = sottosistema(e.file);
      if (k == null) continue;
      if (!perSotto.has(k)) perSotto.set(k, []);
      perSotto.get(k).push(e);
    }
    for (const [sotto, gruppo] of perSotto) {
      const valori = [...new Set(gruppo.map((e) => e.valore))];
      if (valori.length < 2) continue;
      const dove = gruppo.map((e) => `${e.file}:${e.riga} = ${e.valore}`).join(' · ');
      out.push(reperto({
        id: `D1a:${sotto}:${nome}`, regola: 'costante-divergente', severita: 'bassa',
        dove, titolo: `«${nome}» è dichiarata con ${valori.length} valori diversi dentro ${sotto}: ${valori.join(' e ')}`,
        dettaglio: 'Lo stesso nome con due valori nello stesso sottosistema significa che chi legge una delle due righe crede di sapere una cosa che nell\'altro percorso non vale. Se sono due grandezze diverse, meritano due nomi.',
      }));
    }
  }

  // (b) concetti curati sotto nomi diversi
  for (const c of CONCETTI) {
    const viste = trovate.filter((t) => c.nomi.includes(t.nome));
    const valori = [...new Set(viste.map((v) => v.valore))];
    if (valori.length < 2) continue;
    out.push(reperto({
      id: `D1b:${c.nome}`, regola: 'concetto-divergente', severita: 'alta',
      dove: viste.map((v) => `${v.file}:${v.riga} ${v.nome} = ${v.valore}`).join(' · '),
      titolo: `«${c.nome}» vale ${valori.join(' in un posto e ')} nell'altro`,
      dettaglio: c.nota,
    }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D2 · UNA PROTEZIONE CHE STA SU UN PERCORSO E NON SULL'ALTRO
//
// Tabella curata, e deve restarlo: sapere che «fine scala» deve valere su quattro moduli e non su due
// è conoscenza di dominio, non una proprietà del testo. Ogni riga porta il suo incidente.
const PROTEZIONI = [
  {
    id: 'fine-scala',
    nome: 'regola di fine scala (sotto 3¢ / sopra 97¢ un mercato sta risolvendo)',
    marcatore: /end-of-scale|endOfScale|fineScala/,
    percorsi: ['lib/maker/auto-reprice.js', 'lib/maker/mm-tracking.js', 'lib/maker/risk-rails.js', 'lib/maker/manual-order.js'],
    severita: 'alta',
    nota: 'Il 7 agosto 2026 la regola viveva su due percorsi su quattro: agent35 e il pannello manuale potevano piazzare dove agent40 si sarebbe ritirato.',
  },
  {
    id: 'ordini-propri-in-coda',
    nome: 'i nostri ordini sottratti dal book prima di decidere il prezzo',
    marcatore: /ownOrders|resolveOwnOrders/,
    percorsi: ['lib/maker/manual-order.js', 'lib/maker/top-of-book.js', 'lib/maker/auto-reprice.js'],
    severita: 'alta',
    nota: 'Senza questa sottrazione il concorrente da battere siamo noi stessi, e ogni ordine si mette un tick davanti al precedente fino al bordo della banda.',
  },
  {
    id: 'origine-ordine',
    nome: 'il timbro «una mano o un ciclo» sugli ordini',
    // Anche la forma abbreviata `origine,` e il parametro `origine = null`: al primo giro il marcatore
    // cercava solo `origine:` e dichiarava assente bulk-allocate, che invece lo passa (riga 261).
    marcatore: /origine-ordine|origineOrdine|\borigine\s*[,:}=]/,
    percorsi: ['lib/maker/bulk-allocate.js', 'lib/maker/allocation-reset.js'],
    severita: 'media',
    nota: 'Il reset automatico deve poter cancellare SOLO ciò che è provatamente automatico: senza il timbro, manuale e ignoto finirebbero nello stesso mucchio.',
  },
  {
    id: 'kill-switch',
    nome: 'il kill switch letto prima di agire',
    marcatore: /kill-switch|killStatus|effectivelyKilled/,
    percorsi: ['lib/maker/manual-order.js', 'lib/maker/auto-reprice.js', 'lib/maker/bulk-allocate.js'],
    severita: 'alta',
    nota: 'Un percorso che non lo legge è un percorso che continua a piazzare dopo lo STOP di emergenza.',
  },
];

function rilevaProtezioniAsimmetriche(fotografia) {
  const out = [];
  for (const p of PROTEZIONI) {
    const presenti = [], assenti = [], inesistenti = [];
    for (const f of p.percorsi) {
      const testo = fotografia.get(f);
      if (testo == null) { inesistenti.push(f); continue; }
      // Si guarda il CODICE, non i commenti: un modulo che SPIEGA perché non applica una regola non la
      // sta applicando, e un modulo che la nomina in un commento non la sta applicando nemmeno lui.
      const codice = testo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      (p.marcatore.test(codice) ? presenti : assenti).push(f);
    }
    if (inesistenti.length) {
      out.push(reperto({
        id: `D2x:${p.id}`, regola: 'protezione-percorso-ignoto', severita: 'bassa',
        dove: inesistenti.join(' · '),
        titolo: `la regola «${p.id}» elenca percorsi che non esistono più`,
        dettaglio: 'Un file rinominato o rimosso lascia questa tabella a sorvegliare il vuoto: va aggiornata, altrimenti smette di proteggere senza dirlo.',
      }));
    }
    if (assenti.length && presenti.length) {
      out.push(reperto({
        id: `D2:${p.id}`, regola: 'protezione-asimmetrica', severita: p.severita,
        dove: `manca in: ${assenti.join(', ')} · presente in: ${presenti.join(', ')}`,
        titolo: `${p.nome}: presente su ${presenti.length} percorsi, assente su ${assenti.length}`,
        dettaglio: p.nota,
      }));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D3 · LA STIMA CHE DIVERGE DAL CONSUNTIVO
//
// Non ricalcola niente: riceve il verdetto già prodotto da lib/maker/confronto-reward.divergenza e lo
// traduce in un reperto. Una seconda soglia qui dentro sarebbe una seconda opinione sulla stessa
// domanda, cioè esattamente il difetto che D1 esiste per trovare.
function rilevaDerivaStima(divergenza) {
  if (!divergenza) return [];
  if (divergenza.stato === 'divergente') {
    return [reperto({
      id: 'D3:deriva-stima', regola: 'stima-diverge-dal-reale', severita: 'alta',
      dove: 'data/confronto-reward.json · /api/maker/confronto-reward',
      titolo: `la stima ${divergenza.direzione} il consuntivo del venue del ${Math.abs(divergenza.medianaPct).toFixed(1)}% su ${divergenza.osservazioni} giornate`,
      dettaglio: `${divergenza.messaggio} — il bot sceglie i mercati su questa stima, quindi una deriva sistematica sposta il capitale sulla base di un numero sbagliato.`,
    })];
  }
  // Uno scarto grosso ma non ancora sistematico, o non ancora misurabile, non è un allarme — ma è la
  // cosa da guardare per prima al prossimo giro, e sparirebbe se non la si scrivesse.
  if (divergenza.stato === 'dati-insufficienti' && divergenza.osservazioni > 0) {
    return [reperto({
      id: 'D3:deriva-in-formazione', regola: 'stima-diverge-dal-reale', severita: 'bassa',
      dove: 'data/confronto-reward.json',
      titolo: `confronto stima/consuntivo ancora non giudicabile: ${divergenza.osservazioni} giornate su ${divergenza.minimo}`,
      dettaglio: `${divergenza.messaggio} — «dati insufficienti» non è «va tutto bene»: finché non ci sono abbastanza notti, nessuno sta verificando la stima su cui il capitale viene allocato.`,
    })];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D4 · FLAG CHE NESSUNO LEGGE PIÙ
//
// `ambienti` è l'elenco delle variabili viste davvero addosso ai processi (letto da /proc), più quelle
// dichiarate in ecosystem.config.js e in .env. Se nessuna riga di codice fa `process.env.NOME`, quella
// variabile è arredamento: sopravvive ai riavvii e racconta a chi ispeziona una cosa che non è vera.
const ENV_DI_SERVIZIO = new Set([
  'NODE_ENV', 'HOME', 'PATH', 'PWD', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHLVL',
  'OLDPWD', 'HOSTNAME', 'TZ', 'NODE_APP_INSTANCE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE',
  'PM2_HOME', 'PM2_JSON_PROCESSING', 'PM2_USAGE', 'PM2_INTERACTOR_PROCESSING', 'SSH_CLIENT',
  'SSH_CONNECTION', 'SSH_TTY', 'XDG_SESSION_ID', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
  'XDG_SESSION_CLASS', 'MOTD_SHOWN', 'DEBIAN_FRONTEND', 'INIT_CWD', 'npm_lifecycle_event',
]);

// Famiglie di variabili che appartengono al SISTEMA, non al progetto: sessione, desktop, terminale,
// systemd. Nessuna di queste sarà mai un flag del bot, e lasciarle passare significa una coda in cui i
// tre reperti che contano stanno sotto trenta che non contano. Si filtra per famiglia e non a una a
// una: l'elenco puntuale invecchia al primo host diverso.
const ENV_DI_SISTEMA = /^(XDG_|DBUS_|SSH_|SYSTEMD_|TERM_|LESS|LS_COLORS$|COLORTERM$|GPG_|GIT_ASKPASS$|VSCODE_|BROWSER$|EDITOR$|PAGER$|MAIL$|INVOCATION_ID$|JOURNAL_STREAM$|MANAGERPID$|WSL)/;

function rilevaFlagMorti(fotografia, ambienti) {
  const lette = new Set();
  for (const [file, testo] of fotografia) {
    if (!SORGENTE.test(file)) continue;
    const re = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
    let m;
    while ((m = re.exec(testo))) lette.add(m[1] || m[2]);
    // ── LA LETTURA INDIRETTA ──────────────────────────────────────────────────────────────────────
    // `const PRIMARY_ENV = 'KEY_CUSTODY_MASTER'; … process.env[PRIMARY_ENV]` è una lettura a tutti gli
    // effetti, e cercare solo `process.env.NOME` la dichiarava morta. Al primo giro è successo davvero
    // su KEY_CUSTODY_MASTER, che è la chiave con cui si aprono le credenziali: il tipo di falso
    // positivo che fa perdere fiducia in tutto il report.
    // Si accettano quindi anche i letterali MAIUSCOLI, ma SOLO nei file che usano la forma a parentesi:
    // senza quel vincolo qualunque stringa somigliante a un nome di variabile zittirebbe il rilevatore.
    if (/process\.env\s*\[/.test(testo)) {
      const lit = /['"]([A-Z][A-Z0-9_]{2,})['"]/g;
      while ((m = lit.exec(testo))) lette.add(m[1]);
    }
  }
  // ── QUALI VARIABILI SONO CANDIDATE, E QUALI SONO SOLO L'AMBIENTE DELLA SHELL ────────────────────
  // Un processo pm2 eredita tutto quello che aveva la shell che ha avviato il demone: LS_COLORS,
  // LESSOPEN, XDG_*, DBUS_*. Non sono flag del progetto e segnalarli è il modo più rapido di rendere
  // illeggibile la coda (al primo giro erano 30 reperti su 39).
  // È candidata una variabile che (a) il progetto DICHIARA — .env o ecosystem.config.js — oppure
  // (b) condivide il primo pezzo del nome con una che il codice legge davvero. La (b) è quella che
  // serve: REALLOC_SCHEDULER_DRY_RUN non è dichiarata da nessuna parte, ma REALLOC_SCHEDULER_ENABLED
  // sì, ed è così che si riconosce un flag del progetto rimasto orfano.
  const prefissiNoti = new Set([...lette].map((n) => n.split('_')[0]).filter((x) => x.length >= 3));
  const out = [];
  for (const [nome, dove] of ambienti) {
    if (ENV_DI_SERVIZIO.has(nome) || ENV_DI_SISTEMA.test(nome) || lette.has(nome)) continue;
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(nome)) continue;
    if (/^(npm_|_$)/.test(nome)) continue;
    const luoghi = Array.isArray(dove) ? dove : [String(dove)];
    const dichiarata = luoghi.some((l) => l === '.env' || l === 'ecosystem.config.js');
    if (!dichiarata && !prefissiNoti.has(nome.split('_')[0])) continue;
    out.push(reperto({
      id: `D4:${nome}`, regola: 'flag-morto', severita: 'bassa',
      dove: Array.isArray(dove) ? dove.join(' · ') : String(dove),
      titolo: `«${nome}» è nell'ambiente ma nessuna riga di codice la legge`,
      dettaglio: 'Chi ispeziona l\'ambiente la trova e ne deduce un comportamento che non esiste. È il caso di REALLOC_SCHEDULER_DRY_RUN: inerte, ma per due giorni ha fatto credere che agent41 fosse in prova.',
    }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D5 · TEST ROSSI, E LA DIFFERENZA FRA UN VECCHIO NOTO E UNO NUOVO
//
// `rossiNoti` è la lista di quelli già diagnosticati (docs/indagine-cinque-test-rossi.md). Un rosso
// nuovo è una regressione e vale 'alta'; un rosso noto resta un promemoria a 'bassa'. Un noto che
// DIVENTA verde è una buona notizia, e va detta: sparire in silenzio non è la stessa cosa.
function rilevaTestRossi({ rossi = [], rossiNoti = [], nonEseguiti = [], nonEseguibili = [] } = {}) {
  const noti = new Set(rossiNoti);
  const out = [];
  for (const f of rossi) {
    const nuovo = !noti.has(f);
    out.push(reperto({
      id: `D5:${f}`, regola: 'test-rosso', severita: nuovo ? 'alta' : 'bassa',
      dove: f,
      titolo: nuovo ? `test ROSSO NUOVO: ${f}` : `test rosso già noto: ${f}`,
      dettaglio: nuovo
        ? 'Non era nella lista dei rossi diagnosticati: o è una regressione introdotta da poco, o un test che ha cominciato a dipendere da qualcosa di ambientale.'
        : 'Già diagnosticato in docs/indagine-cinque-test-rossi.md — resta qui come promemoria finché non viene chiuso.',
    }));
  }
  for (const f of rossiNoti) {
    if (rossi.includes(f) || nonEseguiti.includes(f)) continue;
    out.push(reperto({
      id: `D5v:${f}`, regola: 'test-tornato-verde', severita: 'bassa',
      dove: f,
      titolo: `un rosso noto è tornato VERDE: ${f}`,
      dettaglio: 'Va tolto dalla lista dei rossi noti, altrimenti la lista comincia a proteggere test che non hanno più bisogno di protezione.',
    }));
  }
  // ── «NON ESEGUIBILE» NON È «ROSSO», ED È UNA DISTINZIONE CHE COSTA CARA CONFONDERE ─────────────
  // Al primo giro tre file sono stati dichiarati «rossi NUOVI» ad alta severità. Non fallivano: non
  // partivano — sono test in JS per moduli TypeScript (`require('./leg-order')` mentre esiste solo
  // `leg-order.ts`), quindi `node` non li carica e non li ha MAI caricati. Un test che non parte non
  // dice niente sul codice: dice che non ha un modo di essere eseguito, ed è un'altra cosa.
  for (const f of nonEseguibili) {
    out.push(reperto({
      id: `D5x:${f}`, regola: 'test-non-eseguibile', severita: 'bassa', dove: f,
      titolo: `test che «node» non riesce nemmeno ad avviare: ${f}`,
      dettaglio: 'Il modulo che importa non si risolve (di solito: test in JS per un modulo TypeScript). Non è un rosso — è un test senza un modo di essere eseguito, quindi una copertura che si crede di avere e non si ha.',
    }));
  }
  if (nonEseguiti.length) {
    out.push(reperto({
      id: 'D5t:non-eseguiti', regola: 'test-non-eseguiti', severita: 'media',
      dove: `${nonEseguiti.length} file`,
      titolo: `${nonEseguiti.length} file di test non sono stati eseguiti: il budget di tempo è finito prima`,
      dettaglio: `Non eseguiti: ${nonEseguiti.slice(0, 8).join(', ')}${nonEseguiti.length > 8 ? '…' : ''}. Un test non eseguito NON è un test verde, e questo report non deve poterlo far sembrare.`,
    }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D6 · CONVENZIONI DI NOME ROTTE
//
// «Un numero, un processo». agent42-guardian e agent42-watch-makers hanno convissuto per un giorno:
// pm2 li distingueva, le persone no.
function rilevaCollisioniNome(processi) {
  const out = [];
  const perNumero = new Map();
  for (const p of processi) {
    const m = /^agent(\d+)\b/.exec(p.nome);
    if (!m) continue;
    if (!perNumero.has(m[1])) perNumero.set(m[1], []);
    perNumero.get(m[1]).push(p);
  }
  for (const [n, elenco] of perNumero) {
    if (elenco.length < 2) continue;
    out.push(reperto({
      id: `D6:agent${n}`, regola: 'collisione-numero', severita: 'media',
      dove: elenco.map((e) => e.nome).join(' · '),
      titolo: `il numero ${n} è usato da ${elenco.length} processi`,
      dettaglio: 'La convenzione di questa flotta è «un numero, un processo» (vedi agent37: «Named 37, not 36»). pm2 li distingue per nome intero; chi legge un log no.',
    }));
  }
  // Nome del processo e nome del file devono coincidere: se divergono, `pm2 logs <nome>` e il file da
  // aprire per capire cosa fa non si trovano più con la stessa parola.
  for (const p of processi) {
    if (!p.script || !/^agent/.test(p.nome)) continue;
    const base = p.script.replace(/^.*\//, '').replace(/\.js$/, '');
    if (base !== p.nome) {
      out.push(reperto({
        id: `D6f:${p.nome}`, regola: 'nome-processo-file', severita: 'bassa',
        dove: `${p.nome} → ${p.script}`,
        titolo: `il processo «${p.nome}» gira il file «${base}.js»`,
        dettaglio: 'Nome del processo e nome del file divergono: chi cerca il codice partendo dal log deve indovinare.',
      }));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// D7 · UN COMMENTO CHE DICHIARA UN VALORE CHE NON È PIÙ QUELLO
//
// Il caso dell'8 agosto 2026: lib/maker/risk-classifier.js scrive nell'intestazione
// «MIN_HORIZON_DAYS = 2», e il valore importato è 0,25. Il meccanismo funzionava — la soglia usata ERA
// quella importata — ma la riga che la descrive era rimasta indietro, su un modulo che apre
// promettendo che le due cose non possano divergere.
//
// Si cerca dentro i commenti la forma `NOME = numero` per i nomi di cui si conosce il valore vero.
function rilevaCommentiInvecchiati(fotografia) {
  // Il valore VERO di ogni costante: la dichiarazione trovata nel codice (non nei commenti).
  const veri = new Map();
  for (const [file, testo] of fotografia) {
    if (!SORGENTE.test(file) || /\.test\.(js|ts)$/.test(file)) continue;
    const senzaCommenti = testo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const c of costantiNumeriche(file, senzaCommenti)) {
      if (!/^[A-Z][A-Z0-9_]{3,}$/.test(c.nome)) continue;
      if (!veri.has(c.nome)) veri.set(c.nome, { valore: c.valore, file });
      else if (veri.get(c.nome).valore !== c.valore) veri.set(c.nome, { valore: null, file: 'più di uno' });
    }
  }
  const out = [];
  for (const [file, testo] of fotografia) {
    if (!SORGENTE.test(file)) continue;
    // ESENTE: il modulo che DOCUMENTA questi incidenti deve poterli citare. È la stessa esenzione che
    // l'hook di piazzamento concede ai `*.test.js`: punire la spiegazione invece del codice è un modo
    // sicuro di far cancellare le spiegazioni.
    if (/^lib\/audit\//.test(file)) continue;
    const righe = testo.split('\n');
    for (let i = 0; i < righe.length; i += 1) {
      const r = righe[i];
      if (!/^\s*(\/\/|\*|\/\*)/.test(r)) continue;              // solo commenti
      // La virgola è un separatore DECIMALE in questi commenti (sono in italiano): leggere «0,8» come
      // «0» produceva un falso positivo al primo giro. Si normalizza invece di indovinare.
      const m = /\b([A-Z][A-Z0-9_]{3,})\s*=\s*(-?\d+(?:[.,]\d+)?)\b/.exec(r);
      if (!m) continue;
      const vero = veri.get(m[1]);
      if (!vero || vero.valore == null) continue;
      if (Number(String(m[2]).replace(',', '.')) === vero.valore) continue;
      out.push(reperto({
        id: `D7:${file}:${m[1]}`, regola: 'commento-invecchiato', severita: 'media',
        dove: `${file}:${i + 1}`,
        titolo: `il commento dice «${m[1]} = ${m[2]}» ma il valore è ${vero.valore}`,
        dettaglio: `Il valore vero è dichiarato in ${vero.file}. Chi legge il commento crede di conoscere una soglia che non è quella applicata — ed è successo davvero l'8 agosto 2026 con MIN_HORIZON_DAYS.`,
      }));
    }
  }
  return out;
}

module.exports = {
  reperto, rilevaCostantiDivergenti, rilevaProtezioniAsimmetriche, rilevaDerivaStima,
  rilevaFlagMorti, rilevaTestRossi, rilevaCollisioniNome, rilevaCommentiInvecchiati,
  costantiNumeriche, CONCETTI, PROTEZIONI, IGNORA, SORGENTE, ENV_DI_SERVIZIO, ENV_DI_SISTEMA,
};

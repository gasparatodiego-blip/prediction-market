#!/usr/bin/env node
'use strict';
// agent44-audit-scoperta — L'AUDIT CONTINUO. TROVA, ARCHIVIA, ESCE.
//
// ═══ COSA FA, E SOPRATTUTTO COSA NON FA ══════════════════════════════════════════════════════════════
// Una volta al giorno legge il codice del bot, cerca i pattern di rischio che in questo progetto hanno
// già prodotto guasti veri, e scrive la coda in `data/audit-coda.{json,md}`. Poi ESCE.
//
// NON corregge niente. NON tocca ordini. NON tocca capitale. NON scrive nessun file che non sia la
// propria coda. Non è una promessa: è come è fatto, ed è verificabile leggendo questo file —
//   · non importa NULLA da lib/maker/ tranne il modulo del confronto reward, che è puro e legge un
//     file di sola lettura (lib/maker/confronto-reward.divergenza);
//   · non importa l'adapter del venue, non importa il signer, non ha credenziali;
//   · l'unica `fs.writeFileSync` fuori da lib/audit/coda.js non esiste: scrive solo la coda.
// `lib/audit/audit-scoperta.test.js` cammina il suo albero dei `require` e fallisce se qualcuno ci
// trascina dentro un modulo che sa piazzare o cancellare.
//
// ═══ PERCHÉ NON È UN PROCESSO SEMPRE VIVO ═══════════════════════════════════════════════════════════
// Il box è una Hetzner a 2 vCPU con dodici processi che gestiscono capitale reale e un load average
// che sta già intorno a 2. Un tredicesimo processo sempre in ascolto costerebbe RAM tutto il giorno per
// lavorare trenta secondi. Quindi: pm2 con `cron_restart` e `autorestart: false` — pm2 lo avvia
// all'ora giusta, lui gira, esce, e resta `stopped` fino al giorno dopo. Fra una scansione e l'altra
// consuma esattamente zero.
//
// ═══ E PERCHÉ NON RUBA RISORSE NEMMENO MENTRE GIRA ══════════════════════════════════════════════════
// Quattro tetti, tutti applicati da lui stesso e non solo dichiarati nella configurazione:
//   1. NICE 19 — la priorità CPU più bassa che Linux conceda. Se un altro processo vuole la CPU, la
//      prende: questo aspetta. `os.setPriority` sul proprio pid, alla prima riga di lavoro.
//   2. IONICE classe 3 (idle) — stessa cosa per il disco, che è la risorsa che questo lavoro consuma
//      davvero (legge qualche centinaio di file). Si applica con `ionice -c 3 -p <pid>` su se stesso.
//   3. TETTO DI TEMPO — `DEADLINE_MS`. Scaduto, si ferma dov'è, scrive quello che ha trovato e MARCA
//      la scansione come parziale. Una scansione incompleta dichiarata vale; una incompleta che si
//      spaccia per completa fa credere che i test non eseguiti siano verdi.
//   4. TETTO DI RAM — `RSS_MAX_MB`, controllato da lui ogni due secondi. `max_memory_restart` di pm2
//      esiste ed è impostato, ma su un processo con `autorestart: false` conta poco: meglio che sia
//      lui a fermarsi, in modo pulito e scrivendo perché.
//
// ═══ L'UNICA COSA CHE ESEGUE, E COME LA RENDE INNOCUA ═══════════════════════════════════════════════
// Per sapere quali test sono rossi bisogna eseguirli. È l'unica parte che fa girare codice altrui, e
// ha tre guardie:
//   · l'AMBIENTE dei figli è ripulito dalle variabili che abilitano il piazzamento
//     (`MANUAL_ORDER_PLACEMENT`, `MAKER_PLACEMENT`, `MAKER_FUNDING_APPROVED`) e `MAKER_MODE` è forzato
//     a `off`. Un test che provasse a piazzare troverebbe i gate chiusi;
//   · si fotografano le date di modifica dei file di STATO sensibili prima e dopo. Se una cambia, è un
//     reperto ad alta severità — il 7 agosto 2026 un test del guardiano ha lasciato residui sullo
//     stato vero, e questo è il rilevatore di quel guasto;
//   · ogni file ha un timeout suo, e l'insieme ha un budget suo dentro il budget totale.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const {
  rilevaCostantiDivergenti, rilevaProtezioniAsimmetriche, rilevaDerivaStima,
  rilevaFlagMorti, rilevaTestRossi, rilevaCollisioniNome, rilevaCommentiInvecchiati,
  reperto, IGNORA, SORGENTE,
} = require('../lib/audit/rilevatori');
const { leggiCoda, fondi, scriviCoda, rendiMarkdown } = require('../lib/audit/coda');

const ROOT = path.resolve(__dirname, '..');
const CODA_JSON = path.join(ROOT, 'data', 'audit-coda.json');
const CODA_MD = path.join(ROOT, 'data', 'audit-coda.md');

// ── I QUATTRO TETTI ─────────────────────────────────────────────────────────────────────────────────
// 12 minuti: la scansione misurata sta sotto i due, e il resto è margine per una macchina carica —
// girando a nice 19 la stessa scansione può allungarsi di parecchio senza che sia un problema.
const DEADLINE_MS = Number(process.env.AUDIT_DEADLINE_MS || 12 * 60_000);
// Il budget dedicato ai test dentro quello totale: oltre, si smette e si dichiara cosa non si è visto.
const BUDGET_TEST_MS = Number(process.env.AUDIT_BUDGET_TEST_MS || 7 * 60_000);
const TIMEOUT_TEST_MS = Number(process.env.AUDIT_TIMEOUT_TEST_MS || 90_000);
// 150 MB: la fotografia del codice sta in decine di MB e il resto è margine. È il taglio che questo
// repo usa già per i processi leggeri (agent37, agent38), quindi non introduce una scala nuova.
const RSS_MAX_MB = Number(process.env.AUDIT_RSS_MAX_MB || 150);
// Un file più grande di così non è codice da leggere: è un giornale. Leggerlo costerebbe I/O per niente.
const MAX_FILE_BYTES = 512 * 1024;

const t0 = Date.now();
let rssMax = 0;
const log = (...a) => console.log(new Date().toISOString(), '[agent44-audit]', ...a);
const scadutoIl = () => Date.now() - t0 > DEADLINE_MS;

/** I file di stato che nessuna scansione deve poter toccare — e che un TEST non dovrebbe toccare mai. */
const STATO_SENSIBILE = [
  'data/maker-bot-enabled.json', 'data/safety-kill-switch.json', 'data/maker-arming.json',
  'data/guardian-baseline.json', 'data/guardian-state.json', 'data/cancellazioni-di-emergenza.json',
  'data/maker-manual-mode.json', 'data/collector-priority.json', 'data/confronto-reward.json',
];

function impronteStato() {
  const out = new Map();
  for (const rel of STATO_SENSIBILE) {
    try { const st = fs.statSync(path.join(ROOT, rel)); out.set(rel, `${st.mtimeMs}:${st.size}`); }
    catch { out.set(rel, 'assente'); }
  }
  return out;
}

/** Priorità CPU e I/O al minimo, su se stesso. Best-effort: se non si può, si dice e si continua. */
function abbassaPriorita() {
  const esiti = [];
  try { os.setPriority(process.pid, 19); esiti.push(`nice ${os.getPriority(process.pid)}`); }
  catch (e) { esiti.push(`nice NON applicato (${e.message})`); }
  try { execFileSync('ionice', ['-c', '3', '-p', String(process.pid)], { timeout: 5_000, stdio: 'ignore' }); esiti.push('ionice classe idle'); }
  catch (e) { esiti.push(`ionice NON applicato (${e.message})`); }
  return esiti.join(' · ');
}

/** La fotografia del codice: `percorso relativo → contenuto`. Salta ciò che non è codice. */
function fotografaCodice() {
  const foto = new Map();
  let byte = 0;
  const cammina = (dir) => {
    if (scadutoIl()) return;
    let voci;
    try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const v of voci) {
      const p = path.join(dir, v.name);
      const rel = path.relative(ROOT, p);
      if (IGNORA.test(rel)) continue;
      if (v.isDirectory()) { cammina(p); continue; }
      if (!SORGENTE.test(v.name)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      try { foto.set(rel, fs.readFileSync(p, 'utf8')); byte += st.size; } catch { /* illeggibile: si salta */ }
    }
  };
  for (const d of ['lib', 'agents', 'scripts', 'app', 'components']) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) cammina(p);
  }
  return { foto, byte };
}

/** Le variabili d'ambiente VERE addosso ai processi del bot, lette da /proc — nessun pm2 da spawnare. */
function ambientiVivi() {
  const out = new Map();
  const agg = (nome, dove) => {
    if (!out.has(nome)) out.set(nome, new Set());
    out.get(nome).add(dove);
  };
  let pid = [];
  try { pid = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { /* niente /proc */ }
  for (const p of pid) {
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'); } catch { continue; }
    const m = /agents\/(agent[\w-]+)\.js/.exec(cmd);
    if (!m) continue;
    let env = '';
    try { env = fs.readFileSync(`/proc/${p}/environ`, 'utf8'); } catch { continue; }
    for (const kv of env.split('\0')) {
      const i = kv.indexOf('=');
      if (i <= 0) continue;
      agg(kv.slice(0, i), `processo ${m[1]}`);
    }
  }
  // E quelle DICHIARATE, che è l'altro posto dove un flag morto sopravvive.
  try {
    for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l);
      if (m) agg(m[1], '.env');
    }
  } catch { /* .env assente */ }
  try {
    const eco = fs.readFileSync(path.join(ROOT, 'agents', 'ecosystem.config.js'), 'utf8');
    const senzaCommenti = eco.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const re = /([A-Z][A-Z0-9_]{2,})\s*:\s*['"]/g;
    let m;
    while ((m = re.exec(senzaCommenti))) agg(m[1], 'ecosystem.config.js');
  } catch { /* assente */ }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

/** I processi dichiarati in ecosystem.config.js: nome e script. Letti dal testo, senza eseguirlo. */
function processiDichiarati() {
  const out = [];
  try {
    const eco = fs.readFileSync(path.join(ROOT, 'agents', 'ecosystem.config.js'), 'utf8');
    const re = /name:\s*'([^']+)',\s*\n\s*script:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(eco))) out.push({ nome: m[1], script: m[2] });
  } catch { /* assente */ }
  return out;
}

/** Il verdetto sulla deriva della stima. Importato, non ricalcolato. */
function verdettoDeriva() {
  try {
    const { leggiConfronto } = require('../lib/maker/confronto-reward');
    return leggiConfronto().divergenza || null;
  } catch { return null; }
}

/** I rossi noti: la lista sta accanto alla loro diagnosi, non dentro questo file. */
function rossiNoti() {
  const f = path.join(ROOT, 'docs', 'indagine-cinque-test-rossi.md');
  try {
    const md = fs.readFileSync(f, 'utf8');
    const re = /`?(lib\/[\w/-]+\.test\.js)`?/g;
    const s = new Set();
    let m;
    while ((m = re.exec(md))) s.add(m[1]);
    return [...s];
  } catch { return []; }
}

/** Esegue UN test. Distingue tre esiti, e la terza è quella che al primo giro mancava:
 *  verde · rosso · NON PARTITO (il modulo che importa non si risolve — un test in JS per un modulo
 *  TypeScript non è mai stato eseguibile con `node`, e chiamarlo «rosso nuovo» è un falso allarme). */
const eseguiTest = (file, env) => new Promise((res) => {
  execFile('node', [file], { cwd: ROOT, timeout: TIMEOUT_TEST_MS, env, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (!err) return res('verde');
      return res(/MODULE_NOT_FOUND|Cannot find module/.test(String(stderr || '')) ? 'non-parte' : 'rosso');
    });
});

/** Esegue i test entro il budget. Restituisce rossi, non eseguiti e le impronte di stato prima/dopo. */
async function passataTest(foto) {
  const files = [...foto.keys()].filter((f) => /\.test\.js$/.test(f)).sort();
  // L'ambiente dei figli: senza le variabili che aprono la porta al venue.
  const env = { ...process.env, MAKER_MODE: 'off' };
  for (const k of ['MANUAL_ORDER_PLACEMENT', 'MAKER_PLACEMENT', 'MAKER_FUNDING_APPROVED']) delete env[k];
  const prima = impronteStato();
  const rossi = [], nonEseguiti = [], nonEseguibili = [];
  const fineBudget = Date.now() + BUDGET_TEST_MS;
  for (const f of files) {
    if (Date.now() > fineBudget || scadutoIl()) { nonEseguiti.push(f); continue; }
    // eslint-disable-next-line no-await-in-loop
    const esito = await eseguiTest(f, env);
    if (esito === 'rosso') rossi.push(f);
    else if (esito === 'non-parte') nonEseguibili.push(f);
  }
  const dopo = impronteStato();
  const toccati = STATO_SENSIBILE.filter((k) => prima.get(k) !== dopo.get(k));
  return { rossi, nonEseguiti, nonEseguibili, toccati, eseguiti: files.length - nonEseguiti.length };
}

(async () => {
  const priorita = abbassaPriorita();
  log(`scansione avviata · ${priorita} · tetti: ${DEADLINE_MS / 60000} min, ${RSS_MAX_MB} MB`);

  // Il controllo di RAM gira per conto suo: se sfonda, si esce puliti invece di essere uccisi.
  const vigile = setInterval(() => {
    const mb = process.memoryUsage().rss / 1048576;
    if (mb > rssMax) rssMax = mb;
    if (mb > RSS_MAX_MB) {
      log(`FERMATO DA SOLO: ${mb.toFixed(0)} MB oltre il tetto di ${RSS_MAX_MB} MB — meglio non finire che competere per la RAM`);
      process.exit(0);
    }
  }, 2_000);
  vigile.unref();

  const impronteIniziali = impronteStato();
  const { foto, byte } = fotografaCodice();
  log(`fotografia: ${foto.size} file, ${(byte / 1048576).toFixed(1)} MB`);

  const trovati = [];
  const passo = (nome, f) => {
    if (scadutoIl()) return false;
    try { trovati.push(...f()); return true; }
    catch (e) { log(`rilevatore «${nome}» non eseguito: ${e.message}`); return true; }
  };

  passo('costanti divergenti', () => rilevaCostantiDivergenti(foto));
  passo('commenti invecchiati', () => rilevaCommentiInvecchiati(foto));
  passo('protezioni asimmetriche', () => rilevaProtezioniAsimmetriche(foto));
  passo('collisioni di nome', () => rilevaCollisioniNome(processiDichiarati()));
  passo('flag morti', () => rilevaFlagMorti(foto, ambientiVivi()));
  passo('deriva della stima', () => rilevaDerivaStima(verdettoDeriva()));

  let esitoTest = { rossi: [], nonEseguiti: [], nonEseguibili: [], toccati: [], eseguiti: 0 };
  if (!scadutoIl()) {
    esitoTest = await passataTest(foto);
    log(`test: ${esitoTest.eseguiti} eseguiti, ${esitoTest.rossi.length} rossi, ${esitoTest.nonEseguibili.length} non avviabili, ${esitoTest.nonEseguiti.length} non eseguiti`);
    trovati.push(...rilevaTestRossi({ rossi: esitoTest.rossi, rossiNoti: rossiNoti(), nonEseguiti: esitoTest.nonEseguiti, nonEseguibili: esitoTest.nonEseguibili }));
    for (const f of esitoTest.toccati) {
      trovati.push(reperto({
        id: `D5s:${f}`, regola: 'test-tocca-stato-reale', severita: 'alta', dove: f,
        titolo: `un test ha modificato lo stato REALE: ${f}`,
        dettaglio: 'Un test deve iniettare le sue dipendenze, non scrivere sui file che governano il bot. Il 7 agosto 2026 è successo davvero: una versione del test del guardiano lasciò il bot su FERMA con un referto datato al futuro.',
      }));
    }
  }

  // Nemmeno la SCANSIONE deve toccare lo stato: se lo ha fatto, è un guasto di questo agente.
  const impronteFinali = impronteStato();
  const toccatiDaMe = STATO_SENSIBILE.filter((k) => impronteIniziali.get(k) !== impronteFinali.get(k)
    && !esitoTest.toccati.includes(k));
  for (const f of toccatiDaMe) {
    trovati.push(reperto({
      id: `D0:${f}`, regola: 'audit-ha-toccato-stato', severita: 'alta', dove: f,
      titolo: `LA SCANSIONE STESSA ha modificato ${f}`,
      dettaglio: 'Questo agente deve essere di sola lettura. Se questa riga compare, è lui il problema: va fermato e corretto prima di fidarsi del resto del report.',
    }));
  }

  const completa = !scadutoIl() && !esitoTest.nonEseguiti.length;
  const adessoIso = new Date().toISOString();
  const precedente = leggiCoda(CODA_JSON);
  const u = fondi(precedente.reperti, trovati, { adessoIso, scansioneN: precedente.scansioni.length + 1 });

  const corpo = {
    versione: 1,
    scansioni: [...precedente.scansioni, {
      at: adessoIso,
      durataSec: Math.round((Date.now() - t0) / 1000),
      rssMaxMb: Math.round(Math.max(rssMax, process.memoryUsage().rss / 1048576)),
      fileLetti: foto.size,
      testEseguiti: esitoTest.eseguiti,
      completa,
      aperti: u.aperti,
      nuovi: u.nuovi, riaperti: u.riaperti, risolti: u.risolti,
      priorita,
    }].slice(-120),
    reperti: u.reperti,
  };
  scriviCoda(CODA_JSON, corpo);
  fs.writeFileSync(CODA_MD, rendiMarkdown(corpo));

  log(`fatto in ${Math.round((Date.now() - t0) / 1000)}s · RAM max ${Math.round(rssMax)} MB · `
    + `aperti ${u.aperti} (nuovi ${u.nuovi.length}, riaperti ${u.riaperti.length}, risolti ${u.risolti.length})`
    + `${completa ? '' : ' · PARZIALE'}`);
  clearInterval(vigile);
  process.exit(0);
})().catch((e) => {
  log('scansione FALLITA:', e && e.stack ? e.stack : String(e));
  process.exit(1);
});

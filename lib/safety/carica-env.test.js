'use strict';
// lib/safety/carica-env.test.js — IL CARICATORE CARICA CIÒ CHE SERVE, E SOPRATTUTTO NON IL RESTO.
//
// ═══ COSA DIFENDE, IN ORDINE DI IMPORTANZA ═════════════════════════════════════════════════════════
// 1. LA PROPRIETÀ DI SICUREZZA. agent34 e agent42 sono descritti in §3 come processi senza chiavi —
//    il secondo come «l'unico che non può toccare capitale nemmeno in linea di principio». Il blocco
//    generico di agent40 carica `.env` PER INTERO, quindi gli metterebbe in ambiente
//    `KEY_CUSTODY_MASTER`, `POLYGON_RPC_URL`, `DATABASE_URL` e `MAKER_FUNDER_ADDRESS`. Nessuna riga di
//    codice le userebbe — ed è esattamente per questo che nessun test esistente sarebbe diventato
//    rosso. Qui si verifica sul `.env` VERO che le famiglie dichiarate non le lascino passare.
// 2. pm2 VINCE SUL FILE. `env[k] === undefined` è la condizione che rende il caricatore incapace di
//    rompere un avvio che oggi funziona — ed è la ragione per cui `REALLOC_SCHEDULER_DRY_RUN` resta
//    inerte dov'è (§5 punto 3).
// 3. CHI NON DICHIARA NON RICEVE. Una lista di famiglie vuota carica ZERO, non «tutto»: un chiamante
//    distratto ottiene il comportamento di prima, che è il verso sicuro.
// 4. I TRE INLINE PREESISTENTI NON SONO STATI TOCCATI. agent40/41/43 hanno il loro blocco generico e
//    devono continuare ad averlo: sono i processi che le credenziali le usano davvero, e
//    `lib/safety/riavvio-automatico.test.js` le estrae da lì con una regex.
//
// Non scrive niente in `data/`: legge il `.env` vero e per il resto usa una cartella temporanea.
//
// Run: node lib/safety/carica-env.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { caricaEnv, consentita } = require('./carica-env');

const RADICE = path.join(__dirname, '..', '..');
const CREDENZIALI = ['DATABASE_URL', 'KEY_CUSTODY_MASTER', 'POLYGON_RPC_URL', 'MAKER_FUNDER_ADDRESS'];
const RISTRETTI = [
  { agente: 'agent24-liquidity-rewards', famiglia: 'REWARD_' },
  { agente: 'agent34-clob-ws', famiglia: 'MID_HISTORY_' },
  { agente: 'agent42-watch-makers', famiglia: 'WATCH21_' },
];
const INLINE = ['agent40-manual-reprice', 'agent41-realloc-scheduler', 'agent43-guardian'];

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const src = (a) => fs.readFileSync(path.join(RADICE, 'agents', `${a}.js`), 'utf8');

/** Estrae dal sorgente dell'agente la lista `consentite` che dichiara, e la valuta. */
function famiglieDichiarate(agente) {
  const m = src(agente).match(/consentite:\s*(\[[^\]]*\])/);
  if (!m) return null;
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · LA PROPRIETÀ DI SICUREZZA: nessuna credenziale entra nei tre processi ristretti');
{
  const envVero = fs.existsSync(path.join(RADICE, '.env'));
  ok('il .env vero esiste (altrimenti questa sezione non proverebbe niente)', envVero);

  for (const { agente, famiglia } of RISTRETTI) {
    const fam = famiglieDichiarate(agente);
    ok(`${agente} dichiara le famiglie che gli servono`, Array.isArray(fam) && fam.length > 0,
      fam ? String(fam) : 'nessuna dichiarazione trovata');
    if (!Array.isArray(fam)) continue;

    ok(`  e la famiglia dichiarata è ${famiglia}`, fam.some((f) => consentita(`${famiglia}X`, [f])));

    // Il caricatore VERO, sul `.env` VERO, sopra un ambiente finto e vuoto.
    const finto = {};
    const r = caricaEnv({ radice: RADICE, consentite: fam, env: finto });
    const trapelate = CREDENZIALI.filter((k) => finto[k] !== undefined);
    ok(`  NESSUNA delle ${CREDENZIALI.length} credenziali entra in ${agente}`, trapelate.length === 0,
      trapelate.length ? `TRAPELATE: ${trapelate.join(', ')}` : `${r.escluse} chiavi del file ignorate`);
    ok(`  e non entra NIENTE che non sia della famiglia`, r.caricate.every((k) => consentita(k, fam)),
      `caricate: ${r.caricate.length ? r.caricate.join(', ') : 'zero (nessuna ' + famiglia + '* in .env, come misurato)'}`);
  }

  // La controprova che rende la sezione onesta: il blocco GENERICO le farebbe passare tutte.
  const finto = {};
  caricaEnv({ radice: RADICE, consentite: [/^[A-Z]/], env: finto });
  const passate = CREDENZIALI.filter((k) => finto[k] !== undefined);
  ok('CONTROPROVA: senza restrizione le credenziali passerebbero davvero', passate.length === CREDENZIALI.length,
    `${passate.length}/${CREDENZIALI.length} — è ciò che il blocco generico avrebbe fatto`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · pm2 vince sul file, e chi non dichiara non riceve');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-env-'));
  fs.writeFileSync(path.join(dir, '.env'), [
    'REWARD_MAX_CLOB_MARKETS=150',
    'REWARD_FAST_MAX_PAGES=120',
    'export WATCH21_POLL_MS=60000',
    'KEY_CUSTODY_MASTER=segretissimo',
    'riga che non e una variabile',
    '# commento',
    '',
  ].join('\n'));

  {
    const env = { REWARD_MAX_CLOB_MARKETS: '400' };
    const r = caricaEnv({ radice: dir, consentite: [/^REWARD_/], env });
    ok('una variabile già presente NON viene sovrascritta', env.REWARD_MAX_CLOB_MARKETS === '400');
    ok('  e viene contata come «già c\'era»', r.gia === 1, `gia=${r.gia}`);
    ok('  mentre l\'altra della stessa famiglia entra', env.REWARD_FAST_MAX_PAGES === '120');
    ok('  e la credenziale resta fuori', env.KEY_CUSTODY_MASTER === undefined);
    ok('  `export` davanti non confonde il parser', caricaEnv({ radice: dir, consentite: [/^WATCH21_/], env: {} }).caricate.length === 1);
  }
  {
    const env = {};
    const r = caricaEnv({ radice: dir, consentite: [], env });
    ok('lista di famiglie VUOTA carica zero (non «tutto»)', r.caricate.length === 0 && Object.keys(env).length === 0);
  }
  {
    const env = {};
    const r = caricaEnv({ radice: path.join(dir, 'non-esiste'), consentite: [/^REWARD_/], env });
    ok('cartella assente: non solleva e non carica', r.caricate.length === 0 && r.letti.length === 0);
  }
  {
    // `.env.local` viene prima e fissa la chiave.
    fs.writeFileSync(path.join(dir, '.env.local'), 'REWARD_FAST_MAX_PAGES=999\n');
    const env = {};
    caricaEnv({ radice: dir, consentite: [/^REWARD_/], env });
    ok('.env.local vince su .env', env.REWARD_FAST_MAX_PAGES === '999');
  }
  {
    const env = {};
    caricaEnv({ radice: dir, consentite: ['REWARD_MAX_CLOB_MARKETS'], env });
    ok('una famiglia può essere anche il nome esatto', env.REWARD_MAX_CLOB_MARKETS === '150' && env.REWARD_FAST_MAX_PAGES === undefined);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · i tre agent usano il modulo, e non hanno più il blocco generico');
{
  for (const { agente } of RISTRETTI) {
    const s = src(agente);
    ok(`${agente} chiama caricaEnv`, /require\(['"]\.\.\/lib\/safety\/carica-env['"]\)\s*\.caricaEnv\(/.test(s));
    ok('  e NON contiene più il ciclo generico su .env', !/for \(const envFile of \[/.test(s));
    // Il caricatore deve stare PRIMA di qualunque require che possa leggere l'ambiente.
    const iCar = s.indexOf('carica-env');
    const iAltro = s.search(/require\('\.\.\/lib\/(?!safety\/carica-env)/);
    ok('  e viene prima del primo require di lib/', iCar >= 0 && (iAltro === -1 || iCar < iAltro),
      `carica-env@${iCar}, primo altro require@${iAltro}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · i tre processi che le credenziali le usano DAVVERO sono intatti');
{
  for (const a of INLINE) {
    const s = src(a);
    ok(`${a} ha ancora il proprio caricatore inline`, /for \(const envFile of \['\.env\.local', '\.env'\]\) \{/.test(s));
    ok('  e non è stato migrato al modulo ristretto', !/carica-env/.test(s),
      'sono i processi che firmano e leggono il capitale: il loro caricatore resta generico e provato da riavvio-automatico.test.js');
  }
}

console.log(`\n===== carica-env: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);

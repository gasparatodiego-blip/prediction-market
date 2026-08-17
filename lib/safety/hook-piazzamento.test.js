#!/usr/bin/env node
'use strict';
// L'HOOK CHE GUARDA DENTRO GLI SCRIPT, NON SOLO LA STRINGA.
//
// ═══ IL BUCO CHE CHIUDE ══════════════════════════════════════════════════════════════════════════════
// Le regole `ask` di .claude/settings.json guardano la stringa del comando, e il file lo dichiara: la
// copertura è per FORME NOTE. `node /tmp/x.js`, dove x.js importa `placeManualOrder`, non nomina
// niente — nessuna regola lo vede, e dall'altra parte c'è capitale reale.
//
// Questo hook apre il file e ne cammina il grafo dei require. Il test verifica le tre cose che contano:
//   1. il piazzamento nominato nel comando viene bloccato;
//   2. il piazzamento NASCOSTO dietro uno script, o dietro una catena di require, viene bloccato lo
//      stesso — ed è il caso per cui l'hook esiste;
//   3. il lavoro di tutti i giorni (git, npm, pm2 in lettura, cat, grep, i test) NON viene toccato.
//      Un hook che blocca troppo viene disattivato, e allora non protegge più niente.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, '.claude', 'hooks', 'blocca-piazzamento.js');

/** Esegue l'hook come lo esegue Claude Code: JSON su stdin, JSON su stdout. */
function esegui(comando, tool = 'Bash') {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command: comando } }),
    encoding: 'utf8', cwd: ROOT,
  });
  const j = JSON.parse(out || '{}');
  const d = j.hookSpecificOutput || {};
  return { bloccato: d.permissionDecision === 'deny', motivo: d.permissionDecisionReason || null, grezzo: j };
}

console.log('\n══ 1 · IL PIAZZAMENTO NOMINATO NEL COMANDO');
{
  const casi = [
    ['curl -X POST localhost:3000/api/maker/manual/order -d @/tmp/o.json', 'rotta manuale'],
    ['curl -X POST localhost:3000/api/maker/manual/replace', 'rotta di riprezzo'],
    ['curl -X POST localhost:3000/api/maker/manual/bulk-allocate', 'allocazione in blocco'],
    ['node scripts/maker-live-test-order.js', 'script di ordine reale'],
    ['MAKER_PLACEMENT=send node agents/agent35-maker.js', 'motore armato'],
    ['node agents/agent35-maker.js', 'motore lanciato a mano, fuori da pm2'],
    ['./agents/agent41-realloc-scheduler.js', 'riallocatore lanciato a mano'],
    ['MANUAL_ORDER_PLACEMENT=send node qualcosa.js', 'piazzamento manuale armato'],
    ['MAKER_MODE=live node agents/agent35-maker.js', 'motore in live'],
  ];
  for (const [cmd, eti] of casi) {
    const r = esegui(cmd);
    ok(`${eti}: BLOCCATO`, r.bloccato, cmd.slice(0, 52));
  }
  const r = esegui('curl -X POST localhost:3000/api/maker/manual/order');
  ok('  e il motivo chiede la conferma IN CHAT', /conferma esplicita dell'utente IN CHAT/.test(r.motivo || ''));
  ok('  e nomina il segnale trovato', /api\/maker\/manual\/order/.test(r.motivo || ''));
}

console.log('\n══ 2 · IL PIAZZAMENTO NASCOSTO — il caso per cui l\'hook esiste');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-piazz-'));

  // (a) Uno script che nomina la funzione. Il comando che lo esegue non nomina niente.
  const diretto = path.join(dir, 'innocuo.js');
  // ⚠ IL PERCORSO DEL REPO SI DERIVA (17 agosto 2026, migrazione root → bot). Era `/root/rewards-bot`,
  // e per il caso (b) qui sotto la differenza non era estetica: `camminaFile` segue un `require` SOLO se
  // il file esiste, quindi con un percorso morto la catena si fermava e l'asserzione era rossa da giorni
  // per una stringa, non per un buco nell'hook.
  fs.writeFileSync(diretto, `const { placeManualOrder } = require(${JSON.stringify(path.join(ROOT, 'lib', 'maker', 'manual-order'))});\nplaceManualOrder({});\n`);
  const a = esegui(`node ${diretto}`);
  ok('script che chiama placeManualOrder ⇒ BLOCCATO', a.bloccato, 'il comando diceva solo «node innocuo.js»');
  ok('  e il motivo dice DENTRO QUALE file', /innocuo\.js|dentro /.test(a.motivo || ''), (a.motivo || '').split('\n')[2]);

  // (b) La catena: lo script non nomina niente, ma richiede un modulo che richiede quello che piazza.
  const foglia = path.join(dir, 'foglia.js');
  fs.writeFileSync(foglia, `module.exports = require(${JSON.stringify(path.join(ROOT, 'lib', 'maker', 'bulk-allocate'))});\n`);
  const mezzo = path.join(dir, 'mezzo.js');
  fs.writeFileSync(mezzo, "module.exports = require('./foglia');\n");
  const cima = path.join(dir, 'cima.js');
  fs.writeFileSync(cima, "const m = require('./mezzo');\nm.qualcosa();\n");
  const b = esegui(`node ${cima}`);
  ok('catena di tre require fino a un modulo che piazza ⇒ BLOCCATO', b.bloccato, 'nessuno dei tre file nomina il piazzamento nel comando');

  // (c) Il commento non è il codice: uno script che NOMINA il piazzamento solo in un commento passa.
  const commento = path.join(dir, 'solo-commento.js');
  fs.writeFileSync(commento, "// questo script NON chiama placeManualOrder, lo dice e basta\nconsole.log('ciao');\n");
  const c = esegui(`node ${commento}`);
  ok('script che nomina il piazzamento SOLO in un commento ⇒ passa', !c.bloccato,
    'il difetto nominato non è il difetto presente');

  // (d) Codice inline.
  const MODULO = path.join(ROOT, 'lib', 'maker', 'manual-order');
  const d1 = esegui(`node -e "require('${MODULO}').placeManualOrder({})"`);
  ok('node -e che piazza ⇒ BLOCCATO', d1.bloccato);
  const d2 = esegui(`node -e "console.log(require('${MODULO}'))"`);
  ok('  e anche il solo require del modulo che piazza ⇒ BLOCCATO', d2.bloccato,
    'importarlo è già metà del gesto');

  // (e) Uno script che esiste ma non piazza: deve passare.
  const pulito = path.join(dir, 'pulito.js');
  fs.writeFileSync(pulito, "const fs = require('fs');\nconsole.log(fs.readdirSync('.').length);\n");
  ok('script che non piazza ⇒ passa', !esegui(`node ${pulito}`).bloccato);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n══ 3 · IL LAVORO DI TUTTI I GIORNI NON VIENE TOCCATO');
{
  const quotidiani = [
    'git status --porcelain', 'git add -A && git commit -m "x"', 'git push origin main',
    'git log --oneline -5', 'git diff -- lib/maker/manual-order.js',
    'npm run build', 'npm run lint', 'npm install',
    'pm2 list', 'pm2 logs dashboard --lines 20 --nostream', 'pm2 describe agent35-maker',
    'cat lib/maker/manual-order.js', 'grep -rn "placeManualOrder" lib/ | head',
    'ls -la data/', 'find . -name "*.test.js"', 'wc -l lib/maker/mm-tracking.js',
    'node lib/maker/mid-vivo.test.js', 'node lib/safety/policy-permessi.test.js',
    'curl -s http://localhost:3000/api/maker/board',
  ];
  for (const cmd of quotidiani) {
    const r = esegui(cmd);
    ok(cmd.slice(0, 54), !r.bloccato, r.bloccato ? 'BLOCCATO PER SBAGLIO' : '');
  }
  // `cat` e `grep` su un file che piazza restano letture: leggere non è eseguire.
  ok('leggere il file che piazza NON è piazzare', !esegui('cat lib/maker/bulk-allocate.js').bloccato);

  console.log('\n── e le due esenzioni non diventano due scorciatoie');
  // (a) IL COMANDO COMPOSTO. Un comando che COMINCIA con una lettura non è una lettura: se bastasse il
  //     primo pezzo, `cat x | curl -X POST .../order` passerebbe. Si valuta ogni segmento.
  for (const cmd of [
    'cat /tmp/o.json | curl -X POST localhost:3000/api/maker/manual/order -d @-',
    'ls -la && curl -X POST localhost:3000/api/maker/manual/order',
    'echo vai; node scripts/maker-live-test-order.js',
    'grep -c x lib/x.js || curl -X POST localhost:3000/api/maker/manual/bulk-allocate',
  ]) {
    ok(`composto che finisce in un piazzamento ⇒ BLOCCATO`, esegui(cmd).bloccato, cmd.slice(0, 56));
  }

  // (b) L'ESENZIONE SUI TEST vale sul CONTENUTO del file, non su chi lo lancia: l'env che arma il
  //     piazzamento l'ha scritto chi lancia, e scatta comunque.
  ok('un test lanciato con il piazzamento ARMATO ⇒ BLOCCATO',
    esegui('MANUAL_ORDER_PLACEMENT=send node lib/maker/mid-vivo.test.js').bloccato,
    'l esenzione copre il contenuto del test, non l ambiente di chi lo esegue');
  ok('  mentre lo stesso test senza quell env passa',
    !esegui('node lib/maker/mid-vivo.test.js').bloccato);

  console.log('\n── (c) descrivere il piazzamento non e piazzare');
  // Questo caso l'ha trovato l'hook bloccando il PROPRIO commit: un messaggio che spiega quali
  // funzioni piazzano contiene per forza quei nomi, e se contiene anche un `|` (per dire
  // «MAKER_MODE=live|on») la segmentazione lo spezza e la prosa non somiglia piu' a niente di innocuo.
  const messaggio = `git commit -F - <<'EOF'
l'hook impara a guardare dentro gli script

Copre postOrder, placeManualOrder e gli env che armano (MAKER_MODE=live|on;
MANUAL_ORDER_PLACEMENT=send). La rotta /api/maker/manual/order resta bloccata.
EOF`;
  ok('un messaggio di commit che SPIEGA il piazzamento ⇒ passa', !esegui(messaggio).bloccato,
    'il corpo di un heredoc e un dato, non una riga di comando');

  // Ma un heredoc dato in pasto a `node` viene ESEGUITO, e li' il corpo torna a contare.
  const eseguito = `node <<'EOF'
require('${path.join(ROOT, 'lib', 'maker', 'manual-order')}').placeManualOrder({});
EOF`;
  ok('  lo stesso corpo dato a `node` ⇒ BLOCCATO', esegui(eseguito).bloccato,
    'li il testo non e un messaggio: e il programma');

  console.log('\n── (d) i separatori dentro le virgolette non separano niente');
  // Anche questo l'ha trovato l'hook, bloccando un grep per via della PROPRIA regex: `\|` dentro le
  // virgolette veniva letto come una pipe, il frammento dopo il taglio non somigliava a niente di
  // innocuo, e il comando finiva giudicato per intero.
  ok('grep con una barra verticale citata ⇒ passa',
    !esegui('grep -rn "inCoda: true\\|inCoda:" app/api/ | head').bloccato,
    'una ricerca non deve essere bloccata dalla sintassi della propria regex');
  ok('  e le virgolette non diventano un modo per nascondersi',
    esegui('curl -X POST "http://localhost:3000/api/maker/manual/' + 'order"').bloccato,
    'la mascheratura vale per la segmentazione, non per l analisi');
}

console.log('\n══ 3-bis · UN RIAVVIO pm2 NON È UN PIAZZAMENTO — e ha già il suo presidio');
{
  // L'hook bloccava `pm2 restart agent35-maker` solo perché il nome compariva. È il blocco sbagliato:
  // un riavvio non piazza un ordine (accende un processo che, alle sue condizioni, potrà farlo), e pm2
  // ha già le sue regole `ask`, che FERMANO il comando e lo mettono davanti all'operatore. Quello è il
  // meccanismo giusto — chiede, e l'operatore risponde in chat. Un DENY non lascia quella possibilità,
  // e l'unico modo di procedere diventerebbe aggirare l'hook.
  for (const cmd of ['pm2 restart agent35-maker', 'pm2 restart agent40-manual-reprice',
    'pm2 restart agent41-realloc-scheduler', 'pm2 restart dashboard',
    'pm2 stop agent35-maker', 'pm2 logs agent35-maker --lines 20 --nostream']) {
    ok(`${cmd.slice(0, 46)} ⇒ passa l'hook`, !esegui(cmd).bloccato, 'lo ferma la regola ask su pm2');
  }
  // …ma lanciare lo stesso agent A MANO, fuori da pm2, resta bloccato: lì nessun'altra regola guarda.
  for (const cmd of ['node agents/agent35-maker.js', `cd ${ROOT} && node agents/agent41-realloc-scheduler.js`,
    'bash -c "node agents/agent40-manual-reprice.js"']) {
    ok(`  ma «${cmd.slice(0, 42)}…» resta BLOCCATO`, esegui(cmd).bloccato);
  }
  // E il presidio di pm2 deve esistere davvero, `start` compreso: senza, avviare un agent fermo
  // sarebbe l'unico modo di accendere un motore senza che niente lo chieda.
  const ask = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8')).permissions.ask;
  for (const verbo of ['restart', 'stop', 'delete', 'reload', 'kill', 'start']) {
    ok(`  la regola ask su «pm2 ${verbo}» esiste`, ask.includes(`Bash(*pm2 ${verbo}*)`));
  }
}

console.log('\n══ 4 · CANCELLARE NON È PIAZZARE');
{
  // Il guardiano delle perdite deve poter cancellare senza chiedere: è la sua unica ragione di esistere.
  for (const cmd of [`node -e "require('${path.join(ROOT, 'lib', 'maker', 'cancel-all')}')"`,
    'curl -X POST localhost:3000/api/maker/cancel']) {
    ok(`${cmd.slice(0, 44)} ⇒ passa`, !esegui(cmd).bloccato, 'cancellare può solo ridurre l esposizione');
  }
}

console.log('\n══ 5 · L\'HOOK È REGISTRATO, E SOLO SU Bash');
{
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const pre = (s.hooks && s.hooks.PreToolUse) || [];
  const nostro = pre.find((g) => (g.hooks || []).some((h) => String(h.command || '').includes('blocca-piazzamento')));
  ok('registrato in .claude/settings.json sotto PreToolUse', !!nostro);
  ok('  con matcher Bash', !!nostro && nostro.matcher === 'Bash', nostro && nostro.matcher);
  ok('  di tipo command', !!nostro && nostro.hooks.every((h) => h.type === 'command'));
  ok('  e con un timeout dichiarato', !!nostro && nostro.hooks.every((h) => Number.isFinite(h.timeout)),
    'un hook che pende è un hook che blocca tutto');

  const altroTool = esegui('curl -X POST localhost:3000/api/maker/manual/order', 'Read');
  ok('un tool che non è Bash non viene giudicato', !altroTool.bloccato, 'il matcher è Bash, e l hook lo ricontrolla');
}

console.log(`\nhook piazzamento: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

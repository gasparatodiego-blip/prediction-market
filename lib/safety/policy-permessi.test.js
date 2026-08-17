#!/usr/bin/env node
'use strict';
// LEGGERE NON È SCRIVERE — E LA POLICY DEI PERMESSI DEVE SAPERLO DIRE.
//
// ═══ IL GUASTO CHE QUESTO TEST IMPEDISCE ═════════════════════════════════════════════════════════════
// Le regole `ask` di `.claude/settings.json` hanno due mestieri diversi, e confonderli costa da tutte e
// due le parti:
//
//   • una regola-ombrello sul NOME di un flag (`Bash(*bot-enabled*)`) ferma anche `cat`, `grep`, `ls`,
//     `git log`: interrompe l'auto mode su ispezioni che non cambiano niente, e chi lavora impara a
//     rispondere «sì» senza leggere il prompt. Un `ask` che scatta sempre non protegge più niente.
//   • una regola troppo stretta lascia passare in silenzio la scrittura vera — `rm`, `sed -i`, una
//     redirezione — sull'interruttore AVVIA/FERMA o sul latch del guardiano delle perdite.
//
// Quindi: per i flag di stato/sicurezza si chiede SOLO sulle forme di scrittura. Per il capitale reale
// (ordini, armamento, gli env che abilitano il piazzamento) e per pm2 si chiede ANCHE in lettura —
// lì basta nominare la cosa, ed è voluto.
//
// ═══ COME SI VERIFICA ════════════════════════════════════════════════════════════════════════════════
// Le regole si applicano a un corpus di comandi VERI: quelli che una sessione digita davvero. Il
// matcher qui sotto è la semantica glob (`*` = qualunque cosa) applicata all'intero comando: è
// l'intenzione della policy, non una reimplementazione del motore dei permessi di Claude Code. Se un
// domani quel motore spezzasse i comandi composti, questo test resterebbe il presidio dell'intenzione.
//
// Il presidio VERO resta la regola 3 di CLAUDE.md §2: sul capitale e sugli interruttori si chiede in
// chat. La policy dei permessi è la seconda linea, non l'unica.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const FILE_PROGETTO = path.join(ROOT, '.claude', 'settings.json');
// ⚠ LA COPIA UTENTE STA NELLA HOME DI CHI ESEGUE, NON IN `/root` (17 agosto 2026, migrazione root →
// bot). Era un letterale, e dopo il cambio di utente questo test non falliva: SOLLEVAVA su `readFileSync`
// prima della prima asserzione — cioe' il presidio sulle due copie divergenti spariva senza dirlo.
const FILE_UTENTE = path.join(require('os').homedir(), '.claude', 'settings.json');
const FILE_LOCALE = path.join(ROOT, '.claude', 'settings.local.json');

const leggi = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const progetto = leggi(FILE_PROGETTO);
const utente = leggi(FILE_UTENTE);
const ask = progetto.permissions.ask;

// Un pattern `Bash(...)` diventa una regex ancorata; il resto (Edit(...), ecc.) non riguarda i comandi.
const bashRules = ask.filter((r) => r.startsWith('Bash(') && r.endsWith(')')).map((r) => r.slice(5, -1));
const aRegex = (glob) => new RegExp('^' + glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const REGOLE = bashRules.map((g) => ({ glob: g, re: aRegex(g) }));
const chiede = (cmd) => REGOLE.filter((r) => r.re.test(cmd)).map((r) => r.glob);

console.log('\n══ 1 · LE DUE COPIE DELLA POLICY SONO LA STESSA POLICY');
{
  ok('.claude/settings.json e ~/.claude/settings.json hanno la stessa lista `ask`',
    JSON.stringify(utente.permissions.ask) === JSON.stringify(ask), `${ask.length} regole`);
  ok('  e lo stesso `allow`',
    JSON.stringify(utente.permissions.allow) === JSON.stringify(progetto.permissions.allow));
  const locale = fs.existsSync(FILE_LOCALE) ? leggi(FILE_LOCALE) : { permissions: { ask: [] } };
  ok('settings.local.json non porta regole `ask`',
    !(locale.permissions && locale.permissions.ask || []).length,
    '`ask` batte `allow` da qualunque file arrivi: una regola qui sarebbe invisibile in git');
  ok('nessuna regola duplicata', new Set(ask).size === ask.length);
}

console.log('\n══ 2 · LA LETTURA PASSA — nessuna di queste tocca niente');
{
  const letture = [
    'cat data/maker-bot-enabled.json',
    'cat data/safety-kill-switch.json',
    'cat data/guardian-baseline.json 2>/dev/null',
    'cat lib/maker/bot-enabled.js',
    'grep -rn "bot-enabled" lib/ agents/',
    'grep -rn "safety-kill" lib/',
    'grep -c enabled data/maker-bot-enabled.json',
    'ls -la data/ | grep guardian',
    'ls -la data/*.json 2>/dev/null | grep bot-enabled',      // il `>` c'è, ma è di /dev/null
    'find . -name "*guardian-state*"',
    'find data -name "maker-arming.json"',
    'wc -l data/maker-arming.json',
    'head -5 data/maker-manual-mode.json',
    'git check-ignore -v data/maker-bot-enabled.json',
    'git log --oneline -- data/guardian-baseline.json',
    'git diff -- data/maker-manual-mode.json',
    'git status --porcelain',
    'pm2 list',
    'pm2 describe agent43-guardian',
    'pm2 env 0',
    'pm2 logs --lines 20 --nostream',
    'timeout 120 node lib/maker/guardian-perdite.test.js',
  ];
  for (const cmd of letture) {
    const m = chiede(cmd);
    ok(cmd, m.length === 0, m.length ? 'chiede per: ' + m.join(', ') : '');
  }

  // ── L'eccezione dichiarata, e il perché. Eseguire un file che NOMINA il flag chiede, anche quando è
  // il suo stesso test: `node lib/maker/bot-enabled.test.js` non è una lettura, è esecuzione di codice.
  // Il 7 agosto 2026 una versione del test del guardiano ha lasciato residui sullo stato VERO
  // (`data/maker-bot-enabled.json` con `by:"agent42-guardian"` e un referto datato al futuro): il
  // costo di un prompt in più su un test è minore del costo di quel pomeriggio.
  ok('eseguire un file che nomina il flag CHIEDE, anche se è un test',
    chiede('node lib/maker/bot-enabled.test.js').length > 0,
    'esecuzione, non lettura: il glob non sa distinguere un test da un `node -e` che scrive');
}

console.log('\n══ 3 · LA SCRITTURA CHIEDE — ogni forma nota, su ogni flag di stato');
{
  const scritture = [
    "echo '{\"enabled\":true}' > data/maker-bot-enabled.json",
    "printf '{}' >data/maker-bot-enabled.json",
    `echo x >> ${ROOT}/data/maker-bot-enabled.json`,
    "sed -i 's/false/true/' data/maker-bot-enabled.json",
    "tee data/safety-kill-switch.json < /tmp/x",
    'truncate -s 0 data/safety-kill-switch.json',
    'rm data/guardian-state.json',
    `rm -f ${ROOT}/data/guardian-state.json`,
    'touch data/guardian-state.json',
    'mv data/guardian-baseline.json /tmp/vecchio.json',
    'cp /tmp/vecchio.json data/guardian-baseline.json',
    'dd of=data/guardian-baseline.json if=/tmp/x',
    "node -e \"require('./lib/maker/bot-enabled').impostaBot(true)\"",
    "python3 -c \"open('data/guardian-state.json','w').write('{}')\"",
    "perl -pi -e 's/a/b/' data/maker-manual-mode.json",
    'bash scripts/kill-maker.sh',
    './scripts/kill-maker.sh',
    "curl -X POST localhost:3000/api/maker/bot -d '{\"enabled\":true}'",
    'curl -X POST localhost:3000/api/maker/kill',
    'git checkout HEAD -- data/maker-bot-enabled.json',
    'git restore data/safety-kill-switch.json',
    'git reset -- data/guardian-state.json',
    "echo '{}' > data/maker-manual-mode.json",
    'rm data/maker-arming.json',
  ];
  for (const cmd of scritture) {
    const m = chiede(cmd);
    ok(cmd, m.length > 0, m.length ? 'ask: ' + m[0] : 'NESSUNA REGOLA LA FERMA');
  }
}

console.log('\n══ 4 · OGNI FLAG DI STATO HA LA FAMIGLIA COMPLETA DELLE FORME DI SCRITTURA');
{
  // Il punto non è che «esiste una regola»: è che la copertura è per FORME, e che aggiungere un flag
  // nuovo senza la famiglia intera lascia un buco silenzioso. Qui si conta.
  const FLAG = ['bot-enabled', 'safety-kill', 'guardian-baseline', 'guardian-state',
    'maker-manual-mode', 'maker-arming'];
  const FORME = ['*> *T*', '*>*T*.json', '*tee*T*', '*sed *T*', '*rm *T*', '*mv *T*', '*cp *T*',
    '*touch *T*', '*truncate*T*', '*dd of=*T*', '*node*T*', '*python*T*', '*perl*T*', '*bash *T*',
    '*sh -c*T*', './*T*', '*git checkout*T*', '*git restore*T*', '*git reset*T*'];
  for (const t of FLAG) {
    const mancanti = FORME.map((f) => f.replace('T', t)).filter((p) => !bashRules.includes(p));
    ok(`${t}: ${FORME.length} forme di scrittura`, mancanti.length === 0,
      mancanti.length ? 'mancano: ' + mancanti.join(', ') : '');
  }
  // I file su cui esiste un percorso fisso hanno anche la regola sullo strumento Edit.
  for (const f of ['maker-bot-enabled.json', 'safety-kill-switch.json', 'maker-arming.json',
    'guardian-baseline.json', 'guardian-state.json', 'maker-manual-mode.json']) {
    ok(`  Edit(data/${f})`, ask.includes(`Edit(/${ROOT}/data/${f})`));
  }
}

console.log('\n══ 5 · IL CAPITALE REALE CHIEDE ANCHE IN LETTURA — e questo NON si allarga');
{
  // Qui la regola è l'opposto della §2, deliberatamente: nominare un ordine reale basta per fermarsi.
  const anchePerNominarli = [
    'grep -rn "MAKER_PLACEMENT" .',
    'grep MAKER_FUNDING_APPROVED .env',
    'grep -n MANUAL_ORDER_PLACEMENT agents/ecosystem.config.js',
    'cat scripts/maker-live-test-order.js',
    'cat scripts/maker-dryrun-place.js',
    'curl -X POST localhost:3000/api/maker/manual/order -d @/tmp/o.json',
    'curl -X POST localhost:3000/api/maker/manual/cancel',
    'curl -X POST localhost:3000/api/maker/manual/replace',
    'curl -X POST localhost:3000/api/maker/manual/bulk-allocate',
    'curl -X POST localhost:3000/api/maker/arm',
    'curl -X POST localhost:3000/api/maker/disarm',
    'node agents/agent35-maker.js',
    'node agents/agent40-manual-reprice.js',
    'MAKER_MODE=live node agents/agent35-maker.js',
  ];
  for (const cmd of anchePerNominarli) {
    const m = chiede(cmd);
    ok(cmd, m.length > 0, m.length ? 'ask: ' + m[0] : 'REGOLA SUL CAPITALE REALE PERSA');
  }
}

console.log('\n══ 6 · pm2: fermare o riavviare si chiede SEMPRE');
{
  // CLAUDE.md §2 regola 2: un\'autorizzazione vale solo per quel riavvio. La policy dei permessi non
  // può ricordarsi «ha già detto sì»: quello che può fare è non lasciar passare mai il comando muto.
  for (const cmd of ['pm2 restart agent41-realloc-scheduler', 'pm2 stop dashboard',
    'pm2 delete agent35-maker', 'pm2 reload all', 'pm2 kill',
    'pm2 startOrRestart agents/ecosystem.config.js', `cd ${ROOT} && pm2 restart dashboard`]) {
    const m = chiede(cmd);
    ok(cmd, m.length > 0, m.length ? 'ask: ' + m[0] : 'IL RIAVVIO PASSEREBBE MUTO');
  }
}

console.log(`\npolicy permessi: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

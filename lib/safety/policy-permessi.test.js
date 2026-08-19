#!/usr/bin/env node
'use strict';
// LA POLICY DEI PERMESSI E' STATA SVUOTATA DALL'OPERATORE — 19 agosto 2026.
//
// ═══ COSA C'ERA QUI, E PERCHE' NON C'E' PIU' ════════════════════════════════════════════════════════
// Questo test difendeva **164 regole `ask`** e un hook `PreToolUse`: la seconda linea che fermava un
// comando prima che toccasse capitale reale, gli interruttori (AVVIA/FERMA, KILL, il latch del
// guardiano) o pm2. L'operatore le ha tolte tutte, consapevolmente e per istruzione esplicita in chat
// («So che e' una protezione vera e la tolgo consapevolmente»), perche' ogni chiamata chiedeva una
// conferma manuale e il lavoro procedeva a clic.
//
// ⚠ IL TEST NON E' STATO AMMORBIDITO: e' stato RISCRITTO sulla proprieta' nuova. La differenza conta.
//   Ammorbidirlo — abbassare una soglia, togliere un'asserzione scomoda — avrebbe lasciato in piedi un
//   test che sembra difendere qualcosa e non difende niente, cioe' la forma esatta delle tre difese
//   rimaste inerti col verde (§5-bis p.181). Qui la proprieta' difesa e' cambiata di segno, ed e'
//   scritta per intero: **la policy e' VUOTA, in ENTRAMBE le copie, e lo e' DELIBERATAMENTE.**
//
// ═══ COSA RESTA A PRESIDIARE IL CAPITALE ════════════════════════════════════════════════════════════
// Una cosa sola, ed e' quella che ha sempre contato di piu': **la regola 3 di CLAUDE.md §2** — sul
// capitale e sugli interruttori si chiede in chat, ogni volta. La policy era la seconda linea, non
// l'unica. Piu' le quattro cinture di §4.14, che vivono nel codice e non nella configurazione.
//
// ═══ COSA VERIFICA ADESSO ═══════════════════════════════════════════════════════════════════════════
//   ① nessuna regola `ask` in nessuna delle tre configurazioni — se ne ricompare una senza che nessuno
//      l'abbia decisa, questo test lo dice;
//   ② nessun hook registrato in nessuna delle tre;
//   ③ le due copie (progetto e utente) restano ALLINEATE fra loro: divergere in silenzio e' il guasto
//      che il test difendeva prima e che difende ancora, solo su un contenuto diverso;
//   ④ il file dell'hook e' ancora sul disco, non registrato: riarmare e' una riga, non una riscrittura.
//
// PER RIARMARE: si rimettono `permissions.ask` e il blocco `hooks` in ENTRAMBE le copie di
// `settings.json` (le copie di sicurezza dell'ultima versione armata sono nello scratchpad della
// sessione del 19 agosto, e la versione integrale e' in `git log` prima di questo commit), e si
// riscrive questo test sulla policy armata. `ask` batte `allow` da qualunque file arrivi.

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

// Un file che non c'e' NON e' un file vuoto: `settings.local.json` puo' legittimamente mancare, le
// altre due no. La differenza si dichiara invece di essere assorbita da un `|| {}`.
function leggi(f, obbligatorio) {
  if (!fs.existsSync(f)) {
    if (obbligatorio) { fail++; console.log(`  ✗ manca ${f}`); }
    return null;
  }
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { fail++; console.log(`  ✗ ${f} non e JSON: ${e.message}`); return null; }
}

const configurazioni = [
  ['progetto', FILE_PROGETTO, leggi(FILE_PROGETTO, true)],
  ['utente', FILE_UTENTE, leggi(FILE_UTENTE, true)],
  ['locale', FILE_LOCALE, leggi(FILE_LOCALE, false)],
];

console.log('\nPOLICY DEI PERMESSI — svuotata per decisione dell\'operatore (19 agosto 2026)\n');

// ══ ① NESSUNA REGOLA `ask` ════════════════════════════════════════════════════════════════════════
console.log('① nessuna regola `ask`');
for (const [nome, file, cfg] of configurazioni) {
  if (cfg === null) { ok(`${nome}: assente, e per «locale» e ammesso`, nome === 'locale'); continue; }
  const ask = (cfg.permissions && cfg.permissions.ask) || [];
  ok(`${nome}: zero regole \`ask\``, Array.isArray(ask) && ask.length === 0,
    ask.length ? `ne sono ricomparse ${ask.length}: ${ask.slice(0, 3).join(' · ')}${ask.length > 3 ? ' …' : ''}` : `${path.basename(file)}`);
}

// ══ ② NESSUN HOOK REGISTRATO ══════════════════════════════════════════════════════════════════════
console.log('\n② nessun hook registrato');
for (const [nome, , cfg] of configurazioni) {
  if (cfg === null) continue;
  const hooks = cfg.hooks;
  const vuoto = hooks === undefined || hooks === null
    || (typeof hooks === 'object' && Object.keys(hooks).length === 0);
  ok(`${nome}: nessun blocco \`hooks\``, vuoto, vuoto ? '' : `presenti: ${Object.keys(hooks).join(', ')}`);
}

// ══ ③ LE DUE COPIE RESTANO ALLINEATE ══════════════════════════════════════════════════════════════
// E' l'unica asserzione sopravvissuta intatta alla riscrittura, ed e' quella che ha sempre morso: due
// copie della stessa policy che divergono lo fanno in silenzio, e `ask` batte `allow` da QUALUNQUE
// file arrivi — quindi una regola rimessa in una sola delle due cambia il comportamento senza che
// l'altra lo dica.
console.log('\n③ le due copie della policy sono allineate');
{
  const p = configurazioni[0][2];
  const u = configurazioni[1][2];
  if (p && u) {
    const askP = (p.permissions && p.permissions.ask) || [];
    const askU = (u.permissions && u.permissions.ask) || [];
    ok('progetto e utente dichiarano lo stesso insieme `ask`',
      JSON.stringify(askP) === JSON.stringify(askU), `progetto ${askP.length} · utente ${askU.length}`);
    const hkP = p.hooks ? Object.keys(p.hooks).sort() : [];
    const hkU = u.hooks ? Object.keys(u.hooks).sort() : [];
    ok('progetto e utente dichiarano gli stessi hook',
      JSON.stringify(hkP) === JSON.stringify(hkU), `progetto [${hkP}] · utente [${hkU}]`);
  } else {
    ok('le due copie sono leggibili', false, 'una delle due non si e letta');
  }
}

// ══ ④ L'HOOK E' SUL DISCO, NON REGISTRATO ═════════════════════════════════════════════════════════
// Non e' stato cancellato: toglierlo dal disco renderebbe il riarmo una riscrittura invece che una
// riga di configurazione, e la decisione dell'operatore era di SPEGNERLO, non di distruggerlo.
console.log('\n④ l\'hook resta sul disco, disarmato');
{
  const hook = path.join(ROOT, '.claude', 'hooks', 'blocca-piazzamento.js');
  ok('`.claude/hooks/blocca-piazzamento.js` esiste ancora: riarmare e una riga', fs.existsSync(hook));
  const registrato = configurazioni.some(([, , cfg]) => cfg && JSON.stringify(cfg.hooks || {}).includes('blocca-piazzamento'));
  ok('…e NON e registrato in nessuna configurazione', !registrato);
}

console.log(`\n${fail === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

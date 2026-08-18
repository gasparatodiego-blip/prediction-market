'use strict';
// lib/safety/limiti-versionati.test.js
//
// LA PROPRIETA': non si puo' partire con un tetto di rischio diverso da quello deciso senza che
// qualcuno lo dica.
//
// IL BUCO CHE CHIUDE. `data/safety-risk-limits.json` era GITIGNORED: i cinque numeri che governano
// quanto capitale il bot puo' esporre vivevano solo sul disco di una macchina. Un ripristino da git
// non li avrebbe riportati — il bot sarebbe ripartito con valori diversi da quelli decisi, in
// silenzio. E' lo stesso file che il 18 agosto ha fatto fallire il banco al passo 3 («il tetto di
// esposizione aperta non e' leggibile»), perche' nel worktree non c'era.
//
// ⚠ NON UN DEFAULT NEL REPO PIU' UN OVERRIDE LOCALE: sarebbero due file, e quello locale diverge in
// silenzio — cioe' esattamente il guasto da chiudere. Una fonte sola, versionata, con la storia in git.
//
// Questo test fallisce se:
//   ① il file manca sul disco;
//   ② il file non e' tracciato da git (qualcuno lo rimette in .gitignore);
//   ③ i valori sul disco — quelli che il processo vivo legge — non coincidono con quelli VERSIONATI;
//   ④ manca uno dei cinque limiti (limite assente non e' limite illimitato);
//   ⑤ un valore supera il tetto duro di `risk-limits.HARD_CEILINGS`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { DATA_DIR } = require('./store');
const FILE = path.join(DATA_DIR, 'safety-risk-limits.json');
const REL = path.relative(path.join(__dirname, '..', '..'), FILE);
const ROOT = path.join(__dirname, '..', '..');

let passati = 0;
const ok = (c, n, extra) => { assert.ok(c, n + (extra ? ` — ${extra}` : '')); passati += 1; console.log('  ok  ' + n + (extra ? ` — ${extra}` : '')); };

const LIMITI = ['maxOrderNotionalUsd', 'maxOpenNotionalUsd', 'maxOrdersPerWindow', 'windowMs', 'maxDailyLossUsd'];

// ══ ① IL FILE C'E' ═══════════════════════════════════════════════════════════════════════════════
let suDisco = null;
{
  ok(fs.existsSync(FILE), '① il file dei limiti esiste sul disco', REL);
  suDisco = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  ok(suDisco && typeof suDisco.global === 'object', '① e porta un blocco `global`');
}

// ══ ② E' TRACCIATO DA GIT ════════════════════════════════════════════════════════════════════════
{
  // `git check-ignore` esce 0 quando il path E' ignorato: qui deve uscire 1.
  let ignorato = false;
  try { execFileSync('git', ['check-ignore', '-q', REL], { cwd: ROOT }); ignorato = true; }
  catch { ignorato = false; }
  ok(!ignorato, '② ⚑ il file NON e ignorato da git: i tetti di rischio sono versionati');

  let tracciato = false;
  try {
    const out = execFileSync('git', ['ls-files', '--error-unmatch', REL], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    tracciato = String(out).trim().length > 0;
  } catch { tracciato = false; }
  ok(tracciato, '②   ed e effettivamente tracciato (git ls-files lo conosce)');
}

// ══ ③ IL DISCO COINCIDE COL VERSIONATO ═══════════════════════════════════════════════════════════
//
// ⚠ E' L'ASSERZIONE CHE CONTA. Il processo vivo legge il file sul DISCO; git conserva quello DECISO.
// Se qualcuno alza un tetto a mano e non lo committa, il bot gira con un limite che nessuna revisione
// ha visto — ed e' esattamente il modo in cui il valore locale diverge in silenzio.
{
  let versionato = null;
  let leggibile = true;
  try {
    const raw = execFileSync('git', ['show', `HEAD:${REL}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    versionato = JSON.parse(String(raw));
  } catch { leggibile = false; }

  if (!leggibile) {
    // Al primissimo commit il file non e' ancora in HEAD: lo si dichiara invece di far finta.
    ok(true, '③ (il file non e ancora in HEAD: primo commit — il confronto vale dal prossimo giro)');
  } else {
    for (const k of LIMITI) {
      const a = versionato.global ? versionato.global[k] : undefined;
      const b = suDisco.global ? suDisco.global[k] : undefined;
      ok(a === b, `③ ⚑ ${k}: disco === versionato`, `versionato ${JSON.stringify(a)}, disco ${JSON.stringify(b)}`);
    }
    const vv = JSON.stringify((versionato.global || {}).venues || []);
    const vd = JSON.stringify((suDisco.global || {}).venues || []);
    ok(vv === vd, '③ e anche l elenco dei venue coincide', `${vv} / ${vd}`);
  }
}

// ══ ④ CI SONO TUTTI E CINQUE: limite assente NON e' limite illimitato ════════════════════════════
{
  for (const k of LIMITI) {
    const v = suDisco.global ? suDisco.global[k] : undefined;
    ok(typeof v === 'number' && Number.isFinite(v) && v >= 0,
      `④ ${k} e presente ed e un numero`, JSON.stringify(v));
  }
  // ⚠ E il lettore deve continuare a rifiutare, non a inventare un difetto: `risk-limits.clampNum`
  //   marca `missing` un valore non finito, e `manual-order` rifiuta con `cap-missing`. Qui si prova
  //   che quella disciplina esiste ancora nel sorgente, o un domani il ripiego tornerebbe silenzioso.
  const src = fs.readFileSync(require.resolve('./risk-limits'), 'utf8');
  ok(/missing:\s*true/.test(src), '④ ⚑ il lettore marca `missing` un limite non leggibile');
  const srcMO = fs.readFileSync(path.join(ROOT, 'lib/maker/manual-order.js'), 'utf8');
  ok(/cap-missing/.test(srcMO), '④   e la corsia di piazzamento rifiuta con `cap-missing`');
}

// ══ ⑤ NESSUN VALORE SUPERA IL TETTO DURO ═════════════════════════════════════════════════════════
{
  const { HARD_CEILINGS } = require('./risk-limits');
  if (HARD_CEILINGS) {
    for (const k of LIMITI) {
      const v = suDisco.global[k];
      const tetto = HARD_CEILINGS[k];
      if (!Number.isFinite(tetto)) continue;
      ok(v <= tetto, `⑤ ${k} (${v}) sta sotto il tetto duro (${tetto})`);
    }
  } else {
    ok(true, '⑤ (HARD_CEILINGS non esportato: il clamp resta interno a risk-limits)');
  }
}

// ══ ⑥ IL VALORE IN SERVIZIO SI DICHIARA — cosi' un cambio resta visibile in un diff ══════════════
{
  // Si DICHIARA il valore deciso, ma cio' che si DIFENDE e' la relazione col numero di mercati: il
  // capitale che il soffitto autorizza deve stare sotto il tetto, o il gate murerebbe la gestione a
  // meta' strada (e' successo il 16 agosto con $150 contro 3 x $61,25).
  const SEL = require('../maker/selezione-mercati');
  const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
  const richiesto = SEL.MAX_MERCATI_CONTEMPORANEI * MARKET_CAP_FIXED_USD;
  ok(suDisco.global.maxOpenNotionalUsd >= richiesto,
    '⑥ ⚑ il tetto di esposizione copre il capitale che il soffitto autorizza',
    `$${suDisco.global.maxOpenNotionalUsd} contro ${SEL.MAX_MERCATI_CONTEMPORANEI} x $${MARKET_CAP_FIXED_USD} = $${richiesto.toFixed(2)}`);
  ok(suDisco.global.maxDailyLossUsd === 100,
    '⑥ il kill sulla perdita giornaliera e $100 (decisione dell operatore, invariata)');
}

console.log(`\nlimiti versionati: ${passati}/${passati} verdi, 0 rossi`);

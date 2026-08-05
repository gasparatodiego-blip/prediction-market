#!/usr/bin/env node
'use strict';
// PRENDERE UN MERCATO IN GESTIONE MANUALE FA PARTE DEL FLUSSO DI PIAZZAMENTO.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Il gate `manual-mode-inactive` impedisce che agent35 e il pannello a mano scrivano sullo stesso libro.
// È corretto e non si tocca. Ma l'ATTIVAZIONE della proprietà manuale non faceva parte del percorso
// «Metti in coda → Conferma e piazza»: la coda accettava il mercato, l'operatore arrivava alla conferma
// finale, e lì il piazzamento veniva rifiutato — con l'unica via d'uscita di lasciare il flusso, aprire
// l'anteprima della card, premere «2 · Conferma e aggiungi», e tornare in coda. È successo su Eric
// Barlow, su Ed Markey e su Dan Green: un ostacolo sistematico, non un caso isolato.
//
// ═══ COSA CAMBIA, E COSA NON CAMBIA ══════════════════════════════════════════════════════════════════
// Cambia CHI fa l'attivazione e QUANDO: la fa la messa in coda, prima che esista un ordine da piazzare.
// NON cambia il gate: se un piazzamento arrivasse su un mercato non manuale, viene rifiutato come oggi.
// Questa modifica aggiunge un passo al flusso, non rimuove un controllo.
//
// NESSUN ORDINE REALE: qui si verifica il gate su funzioni pure, la sequenza del reset su dipendenze
// iniettate, e il resto per lettura del codice del pannello e della route.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

console.log('\n══ 1 · IL GATE RESTA INTATTO: È UNA PROTEZIONE, NON UN INTRALCIO');
{
  const { evaluateManualGate } = require('./manual-order');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gest-manuale-'));
  const stateFile = path.join(dir, 'manual-mode.json');
  const MKT = '0x' + 'ab'.repeat(32);

  // Mercato NON in modalità manuale: il gate rifiuta, con il suo nome e il suo motivo.
  fs.writeFileSync(stateFile, JSON.stringify({ markets: {} }));
  const no = evaluateManualGate({ marketId: MKT }, { stateFile });
  ok('mercato non manuale ⇒ il gate NON permette', no.allow === false);
  ok('  col nome che l operatore vede', no.gate === 'manual-mode-inactive', String(no.gate));
  ok('  e il motivo che spiega perché esiste', /agent35 is still allowed to place and cancel/.test(no.reason));

  // Mercato in modalità manuale: passa, come sempre.
  fs.writeFileSync(stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { manual: true, at: 1, atIso: 'x', by: 'test', reason: 'test' } } }));
  const si = evaluateManualGate({ marketId: MKT }, { stateFile });
  ok('mercato manuale ⇒ il gate permette', si.allow === true && si.gate === null);

  // Stato illeggibile: fail closed, come prima. Non è diventato permissivo per far passare il flusso.
  fs.writeFileSync(stateFile, '{ questo non è json');
  const boh = evaluateManualGate({ marketId: MKT }, { stateFile });
  ok('stato illeggibile ⇒ si rifiuta comunque (fail closed)', boh.allow === false, String(boh.gate));
  ok('  e lo dice con un gate diverso, non lo confonde con «inattiva»',
    boh.gate === 'manual-mode-unreadable', String(boh.gate));

  // E il gate è ancora chiamato dal piazzamento, come PRIMO controllo.
  const mo = leggi('lib', 'maker', 'manual-order.js');
  ok('`placeManualOrder` chiama ancora il gate', /const gate = evaluateManualGate\(\{ marketId \}/.test(mo)
    || /evaluateManualGate\(\{ marketId \}/.test(mo));
  ok('  e `replaceManualOrder` pure', (mo.match(/evaluateManualGate\(/g) || []).length >= 2,
    `${(mo.match(/evaluateManualGate\(/g) || []).length} chiamate`);
}

console.log('\n══ 2 · LA MESSA IN CODA ATTIVA LA GESTIONE MANUALE, E LO VERIFICA');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('la messa in coda legge se la gestione manuale è già attiva',
    /const giaManuale = b\.summary\?\.manualModeActive === true;/.test(p));
  ok('  e se non lo è chiama il percorso di abilitazione che esiste già',
    /if \(!giaManuale\) \{[\s\S]{0,1200}'\/api\/maker\/markets\/enable'/.test(p));
  ok('  con preview:false e takeManual:true, cioè scrivendo davvero',
    /preview: false, enabled: true, takeManual: true/.test(p));
  ok('  dichiarando nel motivo che è la messa in coda a farlo',
    /messa in coda dalla tab Allocazione: il mercato passa in gestione manuale/.test(p));

  ok('LA VERIFICA è sul fatto riletto, non sull esito della scrittura',
    /const attiva = wb\.ok === true && \(wb\.manualModeActive === true \|\| wb\.summary\?\.manualModeActive === true\);/.test(p));
  ok('  e se non è attiva il mercato NON entra in coda',
    /if \(!attiva\) \{[\s\S]{0,700}return;\s*\/\/ NON entra in coda/.test(p));
  ok('  mostrando l errore VERO, non un messaggio inventato',
    /\$\{wb\.error \|\| wb\.note \|\| 'la rilettura non vede la modalità manuale attiva'\}/.test(p));
  ok('  spiegando la conseguenza in italiano',
    /agent35 può ancora scrivere su questo libro/.test(p));

  ok('e l attivazione avviene PRIMA che il mercato entri in coda',
    p.indexOf('const attiva = wb.ok === true') < p.indexOf('setCoda((q) => mettiInCoda({ coda: q, marketId }))'));
}

console.log('\n══ 3 · GIÀ IN GESTIONE MANUALE ⇒ NIENTE DI DIVERSO DA OGGI');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  // L'unica scrittura sta dentro `if (!giaManuale)`: un mercato già manuale non fa partire nessuna
  // chiamata con preview:false, quindi nessuna riscrittura di catalogo, uscita automatica o allowlist.
  const blocco = p.slice(p.indexOf('const giaManuale'), p.indexOf('setCoda((q) => mettiInCoda({ coda: q, marketId }))'));
  const scritture = (blocco.match(/preview: false/g) || []).length;
  ok('esiste UNA sola scrittura in questo percorso', scritture === 1, `${scritture}`);
  ok('  ed è dentro il ramo «non è ancora manuale»',
    blocco.indexOf('if (!giaManuale)') < blocco.indexOf('preview: false'));

  const r = leggi('app', 'api', 'maker', 'markets', 'enable', 'route.ts');
  ok('e anche la route si guarda da sola: scrive solo se non era già manuale',
    /if \(takeManual && !manualBefore\.manual\) \{/.test(r));
}

console.log('\n══ 4 · IL RIEPILOGO PRIMA DELLA CONFERMA LO DICE');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('la testa della coda dichiara la gestione manuale', /data-alloc-queue-manual=/.test(p));
  ok('  distinguendo «l ho preso io adesso» da «c era già»',
    /\? 'preso' : 'gia-attiva'/.test(p));
  ok('  e dicendo cosa comporta: agent35 non scrive più su quel libro',
    /agent35 non piazza né cancella più su questo libro/.test(p));
  ok('  e che resta così finché non lo restituisci',
    /finché non lo restituisci al motore/.test(p));
  ok('il bottone lo dice PRIMA di essere premuto, nel suo title',
    /Se il mercato non è ancora in gestione manuale lo prende in gestione ora/.test(p));
  ok('e il riepilogo del percorso in blocco pure',
    /ognuno viene <b>preso in gestione manuale<\/b>/.test(p));
}

console.log('\n══ 5 · IL PERCORSO SEPARATO PER ABILITARE UN MERCATO RESTA INTATTO');
{
  const p = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('«1 · Anteprima» c è ancora', /1 · Anteprima/.test(p));
  ok('«2 · Conferma e aggiungi» c è ancora', /2 · Conferma e aggiungi/.test(p));
  ok('  e chiama lo stesso `addMarket` di prima', /onClick=\{\(\) => addMarket\(addPreview\.marketId, false/.test(p));
  ok('la spunta «prendi in gestione manuale» resta una scelta dell operatore',
    /const \[takeManual, setTakeManual\] = useState\(true\)/.test(p));
  ok('  e se è disattivata la coda lo dice invece di aggirarla',
    /la spunta «prendi in gestione manuale» è disattivata/.test(p));
}

console.log('\n══ 6 · LA ROUTE VERIFICA LA SCRITTURA, E SI FERMA SE NON HA PRESO');
{
  const r = leggi('app', 'api', 'maker', 'markets', 'enable', 'route.ts');
  ok('dopo la scrittura rilegge con la funzione che il gate userà',
    /const dopo = isManualMarket\(id\);/.test(r));
  ok('  e il fermo scatta sull uno O sull altro', /if \(!manual\.ok \|\| !manualOra\) \{/.test(r));
  ok('  con un gate suo, non un ok:true silenzioso', /gate: 'manual-mode-write-failed'/.test(r));
  ok('  e uno stato HTTP che il pannello non può ignorare', /status: 409/.test(r));
  ok('  dicendo cosa resta scritto e cosa non è pronto',
    /Catalogo, uscita automatica e allowlist sono già scritti/.test(r));
  ok('la risposta riuscita porta il fatto RILETTO, non l esito della scrittura',
    /manualModeActive: manualOra,/.test(r));
  ok('  e un eccezione nella scrittura non passa per riuscita', /catch \(e\) \{\s*manual = \{ ok: false/.test(r));
}

console.log('\n══ 7 · IL PERCORSO IN BLOCCO: SENZA GESTIONE MANUALE NON SI PIAZZA');
(async () => {
  const { runAllocationReset } = require('./allocation-reset');
  const MKT = '0x' + 'cc'.repeat(32);
  const PIANO = [{ marketId: MKT, book: 'yes', price: 0.5, size: 100 }];
  const mondo = () => {
    const piazzati = [];
    const deps = {
      now: (() => { let t = 1_800_000_000_000; return () => (t += 10); })(),
      readEnabled: () => [],
      readTracking: () => [],
      listOrders: async () => ({ ok: true, simulated: false, orders: [] }),
      cancelOrder: async () => ({ ok: true }),
      setTrackingOff: async () => ({ ok: true }),
      setEnabled: async () => ({ ok: true }),
      setAutoClose: async () => ({ ok: true }),
      posizioneAperta: async () => ({ leggibile: true, aperta: false }),
      placeBulk: async ({ rows }) => { piazzati.push(...rows); return { ok: true, placed: rows.length, refused: 0, skipped: 0, results: [], totals: { rows: rows.length } }; },
      audit: () => {},
    };
    return { deps, piazzati };
  };

  // La scrittura della proprietà manuale FALLISCE ⇒ non si piazza niente.
  {
    const m = mondo();
    m.deps.setManual = async () => ({ ok: false, error: 'disco pieno' });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('gestione manuale fallita ⇒ NESSUN ordine piazzato', m.piazzati.length === 0, `${m.piazzati.length} piazzati`);
    ok('  e la sequenza si ferma dichiarandolo', r.stoppedBy === 'enable-failed', String(r.stoppedBy));
    ok('  nominando la gestione manuale fra le condizioni', /gestione manuale/.test(r.reason || ''), String(r.reason).slice(0, 80));
    ok('  e contando su quanti mercati manca', /Gestione manuale NON attiva su 1 mercato/.test(r.reason || ''));
    ok('  col motivo vero a verbale', /disco pieno/.test(JSON.stringify(r)));
  }
  // La dipendenza NON cablata è lo stesso caso: una decisione che nessuno può eseguire non è un permesso.
  {
    const m = mondo();
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('`setManual` non iniettata ⇒ NESSUN ordine piazzato', m.piazzati.length === 0, `${m.piazzati.length} piazzati`);
    ok('  e lo dice invece di tacere', /nessuna funzione setManual iniettata/.test(JSON.stringify(r)));
  }
  // Il caso normale: tutto riesce, e si piazza come prima.
  {
    const m = mondo();
    m.deps.setManual = async () => ({ ok: true, manual: true });
    const r = await runAllocationReset({ rows: PIANO }, m.deps);
    ok('con la gestione manuale attiva si piazza, come prima', r.stoppedBy == null, String(r.stoppedBy));
    ok('  una riga del piano, un piazzamento', m.piazzati.length === 1, `${m.piazzati.length}`);
    ok('  e il referto dice che quel mercato è manuale',
      (r.accensione?.markets || []).length > 0 && r.accensione.markets.every((x) => x.manual === true));
  }

  // E i due chiamanti veri la cablano.
  {
    const bulk = leggi('app', 'api', 'maker', 'manual', 'bulk-allocate', 'route.ts');
    ok('la route in blocco cabla `setManual`', /setManual: \(\{/.test(bulk));
    const a41 = leggi('agents', 'agent41-realloc-scheduler.js');
    ok('e il riallocatore periodico pure', /setManual: /.test(a41));
    ok('  col dry-run di agent41 ancora al suo posto', /REALLOC_SCHEDULER_DRY_RUN/.test(a41));
  }

  console.log(`\ngestione manuale nel flusso: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

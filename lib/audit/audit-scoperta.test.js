#!/usr/bin/env node
'use strict';
// L'AUDIT DI SCOPERTA — I RILEVATORI, LA MEMORIA DELLA CODA, E LA PROVA CHE NON PUÒ TOCCARE CAPITALE.
//
// Le proprietà che contano:
//   1. ogni rilevatore trova il caso che è nato per trovare, e NON trova quello che gli somiglia;
//   2. la coda non fa sparire niente: un reperto che non si ritrova diventa «risolto», non svanisce,
//      e uno che torna dopo essere stato risolto è «riaperto» — perché di solito vuol dire che il fix
//      non teneva;
//   3. `primaVisto` non viene mai sovrascritto: un problema aperto da nove giorni e uno di stanotte
//      meritano attenzioni diverse, e la differenza si legge solo se la prima data resta;
//   4. l'agente è STRUTTURALMENTE incapace di toccare ordini o capitale — provato camminando il suo
//      albero dei `require`, non promesso in un commento.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./rilevatori');
const C = require('./coda');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const ROOT = path.resolve(__dirname, '..', '..');

console.log('\n══ 1 · D1 · LA STESSA SOGLIA, DUE VALORI');
{
  const foto = new Map([
    ['lib/maker/motore.js', 'const MARKET_CAP_PCT = 0.20;\n'],
    ['lib/rewards/concentration.js', 'const CONCENTRATION_CAP_FRAC = 0.30;\n'],
  ]);
  const t = R.rilevaCostantiDivergenti(foto);
  const c = t.find((x) => x.regola === 'concetto-divergente');
  ok('il tetto di concentrazione a due valori viene trovato anche sotto DUE NOMI diversi', !!c, c && c.titolo);
  ok('  ed è alta severità: cambia cosa il bot fa col capitale', c && c.severita === 'alta');

  const uguali = R.rilevaCostantiDivergenti(new Map([
    ['lib/maker/motore.js', 'const MARKET_CAP_PCT = 0.20;\n'],
    ['lib/rewards/concentration.js', 'const CONCENTRATION_CAP_FRAC = 0.20;\n'],
  ]));
  ok('se i due valori COINCIDONO non si segnala niente: la regola cerca il disaccordo, non la ripetizione',
    !uguali.some((x) => x.regola === 'concetto-divergente'));
}
{
  // Il rumore che questa regola deve NON produrre: due programmi indipendenti con una costante omonima.
  const rumore = R.rilevaCostantiDivergenti(new Map([
    ['agents/agent16-poly-hft.js', 'const MAX_RPS = 1;\n'],
    ['agents/agent17-poly-whales.js', 'const MAX_RPS = 3;\n'],
  ]));
  ok('due AGENT indipendenti con la stessa costante omonima NON sono un reperto', rumore.length === 0,
    'senza questa restrizione il primo giro produceva 14 reperti, tutti omonimie');
  const dentroLib = R.rilevaCostantiDivergenti(new Map([
    ['lib/maker/a.js', 'const SOGLIA_TTL = 30;\n'],
    ['lib/maker/b.js', 'const SOGLIA_TTL = 45;\n'],
  ]));
  ok('due moduli dello STESSO sottosistema, invece, sì', dentroLib.length === 1, dentroLib[0] && dentroLib[0].titolo);
}

console.log('\n══ 2 · D7 · UN COMMENTO CHE DICHIARA UN VALORE CHE NON È PIÙ QUELLO');
{
  const foto = new Map([
    ['lib/rewards/horizon.js', 'const MIN_HORIZON_DAYS = 0.25;\n'],
    ['lib/maker/risk-classifier.js', '// · MIN_HORIZON_DAYS = 2   la soglia che il profilo Safe applica\nconst x = 1;\n'],
  ]);
  const t = R.rilevaCommentiInvecchiati(foto);
  ok('il commento fermo al valore vecchio viene trovato', t.length === 1, t[0] && t[0].titolo);
  ok('  e dice dove sta il valore vero', t[0] && /horizon\.js/.test(t[0].dettaglio));

  const virgola = R.rilevaCommentiInvecchiati(new Map([
    ['lib/a.js', 'const CONCORDANZA_MINIMA = 0.8;\n'],
    ['lib/b.js', '// CONCORDANZA_MINIMA = 0,8 — almeno l\'80% nello stesso verso\nconst y = 1;\n'],
  ]));
  ok('«0,8» con la VIRGOLA decimale non viene letto come «0»: era il falso positivo del primo giro',
    virgola.length === 0);

  const allineato = R.rilevaCommentiInvecchiati(new Map([
    ['lib/rewards/horizon.js', 'const MIN_HORIZON_DAYS = 0.25;\n'],
    ['lib/maker/x.js', '// MIN_HORIZON_DAYS = 0.25 — allineato\nconst z = 1;\n'],
  ]));
  ok('un commento ALLINEATO non è un reperto', allineato.length === 0);

  const seStesso = R.rilevaCommentiInvecchiati(new Map([
    ['lib/rewards/horizon.js', 'const MIN_HORIZON_DAYS = 0.25;\n'],
    ['lib/audit/rilevatori.js', '// il caso: MIN_HORIZON_DAYS = 2 scritto mentre il valore vero è 0,25\nconst q = 1;\n'],
  ]));
  ok('il modulo che DOCUMENTA l incidente può citarlo senza essere accusato di averlo',
    seStesso.length === 0, 'stessa esenzione che l hook concede ai *.test.js: punire la spiegazione fa cancellare le spiegazioni');
}

console.log('\n══ 3 · D2 · UNA PROTEZIONE SU UN PERCORSO E NON SULL ALTRO');
{
  const conTutte = new Map();
  for (const p of R.PROTEZIONI) for (const f of p.percorsi) conTutte.set(f, 'end-of-scale ownOrders origine: kill-switch');
  ok('quando ogni percorso ha la sua protezione, nessun reperto',
    R.rilevaProtezioniAsimmetriche(conTutte).filter((x) => x.regola === 'protezione-asimmetrica').length === 0);

  const bucata = new Map(conTutte);
  bucata.set('lib/maker/risk-rails.js', 'nessuna regola qui dentro');
  const t = R.rilevaProtezioniAsimmetriche(bucata);
  const fs2 = t.find((x) => x.id === 'D2:fine-scala');
  ok('tolta la regola di fine scala da UN percorso, il buco si vede', !!fs2, fs2 && fs2.titolo);
  ok('  ed è alta severità: è la regola che tiene fuori dai mercati che stanno risolvendo', fs2 && fs2.severita === 'alta');

  // Un modulo che SPIEGA perché non applica una regola non la sta applicando: il rilevatore guarda il
  // codice, non i commenti. È lo stesso errore già fatto due volte in questo repo.
  const soloCommento = new Map(conTutte);
  soloCommento.set('lib/maker/risk-rails.js', '// qui NON si applica end-of-scale, e il motivo è lungo\nconst a = 1;');
  ok('un commento che NOMINA la regola non conta come regola applicata',
    R.rilevaProtezioniAsimmetriche(soloCommento).some((x) => x.id === 'D2:fine-scala'));

  const sparito = new Map(conTutte);
  sparito.delete('lib/maker/mm-tracking.js');
  ok('un percorso che non esiste più viene detto, invece di sorvegliare il vuoto',
    R.rilevaProtezioniAsimmetriche(sparito).some((x) => x.regola === 'protezione-percorso-ignoto'));
}

console.log('\n══ 4 · D4 · FLAG CHE NESSUNO LEGGE PIÙ');
{
  const foto = new Map([['lib/x.js', 'const a = process.env.USATA;\n']]);
  const amb = new Map([['USATA', ['.env']], ['MORTA', ['processo agent41', '.env']], ['NODE_ENV', ['.env']]]);
  const t = R.rilevaFlagMorti(foto, amb);
  ok('la variabile che nessuna riga legge viene trovata', t.length === 1 && t[0].id === 'D4:MORTA');
  ok('  con l elenco di DOVE sopravvive', /agent41/.test(t[0].dove));
  ok('quella letta non viene segnalata', !t.some((x) => x.id === 'D4:USATA'));
  ok('e le variabili di servizio del sistema restano fuori: sarebbero rumore infinito',
    !t.some((x) => x.id === 'D4:NODE_ENV'));
  ok('le variabili di SESSIONE del sistema restano fuori per famiglia, non a una a una', (() => {
    const t2 = R.rilevaFlagMorti(new Map([['lib/x.js', 'process.env.LETTA']]),
      new Map([['XDG_DATA_DIRS', ['processo agent35']], ['TERM_PROGRAM', ['processo agent35']], ['SSH_CLIENT', ['processo agent35']]]));
    return t2.length === 0;
  })(), 'al primo giro erano trenta reperti su trentanove: la coda diventava illeggibile');
  ok('una lettura INDIRETTA conta come lettura', (() => {
    const t2 = R.rilevaFlagMorti(
      new Map([['lib/key-custody.js', "const PRIMARY_ENV = 'KEY_CUSTODY_MASTER';\nconst v = process.env[PRIMARY_ENV];"]]),
      new Map([['KEY_CUSTODY_MASTER', ['.env']]]));
    return t2.length === 0;
  })(), 'KEY_CUSTODY_MASTER è la chiave delle credenziali: dichiararla morta era il falso positivo peggiore');
  ok('  ma il letterale vale solo dove si usa DAVVERO la forma a parentesi', (() => {
    const t2 = R.rilevaFlagMorti(
      new Map([['lib/x.js', "const nota = 'CAPITAL_USD serve per...';"]]),
      new Map([['CAPITAL_USD', ['.env']]]));
    return t2.length === 1;
  })());
  ok('un flag ORFANO ma imparentato con uno letto viene trovato: è il caso REALLOC_SCHEDULER_DRY_RUN', (() => {
    const t2 = R.rilevaFlagMorti(
      new Map([['agents/a.js', 'process.env.REALLOC_SCHEDULER_ENABLED']]),
      new Map([['REALLOC_SCHEDULER_DRY_RUN', ['processo agent41']]]));
    return t2.length === 1 && t2[0].id === 'D4:REALLOC_SCHEDULER_DRY_RUN';
  })(), 'non è in .env né in ecosystem: si riconosce dal prefisso condiviso con una che il codice legge');
  ok('anche `process.env["NOME"]` conta come lettura', (() => {
    const t2 = R.rilevaFlagMorti(new Map([['lib/x.js', 'process.env["ALTRA"]']]), new Map([['ALTRA', ['.env']]]));
    return t2.length === 0;
  })());
}

console.log('\n══ 5 · D5 · ROSSI NUOVI, ROSSI NOTI, E ROSSI TORNATI VERDI');
{
  const noti = ['lib/maker/vecchio.test.js'];
  const t = R.rilevaTestRossi({ rossi: ['lib/maker/vecchio.test.js', 'lib/nuovo.test.js'], rossiNoti: noti });
  const nuovo = t.find((x) => x.id === 'D5:lib/nuovo.test.js');
  const noto = t.find((x) => x.id === 'D5:lib/maker/vecchio.test.js');
  ok('un rosso NUOVO è alta severità: è una regressione', nuovo && nuovo.severita === 'alta');
  ok('  un rosso già diagnosticato resta un promemoria a bassa', noto && noto.severita === 'bassa');

  const verde = R.rilevaTestRossi({ rossi: [], rossiNoti: noti });
  ok('un rosso noto che torna VERDE viene detto, non lasciato sparire',
    verde.some((x) => x.regola === 'test-tornato-verde'));

  const parziale = R.rilevaTestRossi({ rossi: [], rossiNoti: [], nonEseguiti: ['a.test.js', 'b.test.js'] });
  ok('i test NON eseguiti sono un reperto a sé: un test non eseguito non è un test verde',
    parziale.length === 1 && parziale[0].severita === 'media');
  ok('  e un noto non eseguito NON viene dichiarato tornato verde',
    !R.rilevaTestRossi({ rossi: [], rossiNoti: noti, nonEseguiti: noti }).some((x) => x.regola === 'test-tornato-verde'));
}

console.log('\n══ 6 · D6 · UN NUMERO, UN PROCESSO');
{
  const t = R.rilevaCollisioniNome([
    { nome: 'agent42-guardian', script: './agents/agent42-guardian.js' },
    { nome: 'agent42-watch-makers', script: './agents/agent42-watch-makers.js' },
    { nome: 'agent41-realloc-scheduler', script: './agents/agent41-realloc-scheduler.js' },
  ]);
  ok('la collisione sul numero 42 viene trovata', t.some((x) => x.id === 'D6:agent42'));
  ok('  e il 41, che è solo, non viene toccato', !t.some((x) => x.id === 'D6:agent41'));
  const div = R.rilevaCollisioniNome([{ nome: 'agent43-guardian', script: './agents/agent42-guardian.js' }]);
  ok('processo e file che non si chiamano uguale: chi cerca il codice dal log deve indovinare',
    div.some((x) => x.regola === 'nome-processo-file'));
}

console.log('\n══ 7 · D3 · LA STIMA CHE DIVERGE DAL CONSUNTIVO');
{
  ok('nessun verdetto ⇒ nessun reperto inventato', R.rilevaDerivaStima(null).length === 0);
  const d = R.rilevaDerivaStima({ stato: 'divergente', direzione: 'sovrastima', medianaPct: 137, osservazioni: 6, messaggio: 'msg' });
  ok('un verdetto di deriva è alta severità', d.length === 1 && d[0].severita === 'alta', d[0] && d[0].titolo);
  ok('  «coerente» non produce niente', R.rilevaDerivaStima({ stato: 'coerente', osservazioni: 6 }).length === 0);
  const ins = R.rilevaDerivaStima({ stato: 'dati-insufficienti', osservazioni: 1, minimo: 5, messaggio: 'servono 5' });
  ok('«dati insufficienti» CON almeno una giornata resta scritto: non è «va tutto bene»',
    ins.length === 1 && ins[0].severita === 'bassa');
  ok('  ma con zero giornate non si dice niente: non c è ancora niente da dire',
    R.rilevaDerivaStima({ stato: 'dati-insufficienti', osservazioni: 0 }).length === 0);
}

console.log('\n══ 8 · LA CODA: UNA MEMORIA, NON UNA FOTOGRAFIA');
{
  const r = (id, sev = 'media') => ({ id, regola: 'x', severita: sev, dove: 'd', titolo: 't' + id, dettaglio: 'e' });
  const g1 = C.fondi([], [r('A'), r('B')], { adessoIso: '2026-08-01T00:00:00Z' });
  ok('prima scansione: tutto è nuovo', g1.nuovi.length === 2 && g1.aperti === 2);

  const g2 = C.fondi(g1.reperti, [r('A')], { adessoIso: '2026-08-02T00:00:00Z' });
  const B = g2.reperti.find((x) => x.id === 'B');
  ok('un reperto che non si ritrova NON sparisce: diventa risolto', B && B.stato === 'risolto');
  ok('  con la data in cui lo era ancora e quella in cui non lo era più',
    B.risoltoIl === '2026-08-02T00:00:00Z' && B.primaVisto === '2026-08-01T00:00:00Z');
  ok('  ed è contato fra i risolti di quella scansione', g2.risolti.includes('B') && g2.aperti === 1);
  const A2 = g2.reperti.find((x) => x.id === 'A');
  ok('un reperto che resta NON viene marcato nuovo una seconda volta', !g2.nuovi.includes('A'));
  ok('  e la sua PRIMA data non viene sovrascritta: è l età del problema', A2.primaVisto === '2026-08-01T00:00:00Z');
  ok('  mentre l ultima avanza', A2.ultimoVisto === '2026-08-02T00:00:00Z' && A2.scansioniViste === 2);

  const g3 = C.fondi(g2.reperti, [r('A'), r('B')], { adessoIso: '2026-08-03T00:00:00Z' });
  const B3 = g3.reperti.find((x) => x.id === 'B');
  ok('un reperto che TORNA è «riaperto», non «nuovo»: di solito vuol dire che il fix non teneva',
    g3.riaperti.includes('B') && !g3.nuovi.includes('B') && B3.stato === 'aperto' && B3.risoltoIl === null);
  ok('  e conserva la data della PRIMA volta, non quella del ritorno', B3.primaVisto === '2026-08-01T00:00:00Z');

  // Il difetto trovato PROVANDO il tetto di tempo: una scansione arrivata a 29 test su 126 marcava
  // «risolti» cinque reperti che non aveva nemmeno guardato. Non aver cercato non è aver cercato e non
  // trovato, e la differenza è tutto il valore di questa coda.
  const parz = C.fondi(g1.reperti, [r('A')], { adessoIso: '2026-08-04T00:00:00Z', parziale: true });
  ok('una scansione PARZIALE non risolve niente: non aver guardato non è aver guardato e non trovato',
    parz.risolti.length === 0 && parz.reperti.find((x) => x.id === 'B').stato === 'aperto');
  ok('  ma continua a registrare ciò che HA trovato', parz.reperti.find((x) => x.id === 'A').ultimoVisto === '2026-08-04T00:00:00Z');

  const ordinati = C.fondi([], [r('X', 'bassa'), r('Y', 'alta'), r('Z', 'media')], {}).reperti;
  ok('gli aperti escono dal più grave', ordinati.map((x) => x.id).join('') === 'YZX');

  // La vista markdown: si rigenera, e non deve poter perdere la storia.
  const corpo = { versione: 1, scansioni: [{ at: '2026-08-03T00:00:00Z', durataSec: 12, rssMaxMb: 40, aperti: 2, nuovi: [], riaperti: ['B'], risolti: [], completa: true }], reperti: g3.reperti };
  const md = C.rendiMarkdown(corpo);
  ok('il markdown mostra gli aperti', /tA/.test(md) && /tB/.test(md));
  ok('  segnala i riaperti', /RIAPERTO/.test(md));
  ok('  e dichiara quando una scansione è PARZIALE', /PARZIALE/.test(C.rendiMarkdown({ ...corpo, scansioni: [{ ...corpo.scansioni[0], completa: false }] })));
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const f = path.join(dir, 'coda.json');
  ok('una coda assente è la PRIMA scansione, non un errore', C.leggiCoda(f).reperti.length === 0 && /prima scansione/.test(C.leggiCoda(f).motivo));
  fs.writeFileSync(f, '{ rotto');
  ok('una coda rotta non fa perdere il giro: si riparte da vuoto e lo si dice', C.leggiCoda(f).reperti.length === 0 && /illeggibile/.test(C.leggiCoda(f).motivo));
  C.scriviCoda(f, { versione: 1, scansioni: [], reperti: [{ id: 'A', stato: 'aperto' }] });
  ok('scritta e riletta, la coda torna uguale', C.leggiCoda(f).reperti.length === 1);
  ok('  e non resta nessun file temporaneo in giro', !fs.existsSync(`${f}.tmp`));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n══ 9 · L AGENTE NON PUÒ TOCCARE ORDINI NÉ CAPITALE — PROVA SUL GRAFO DEI REQUIRE');
{
  const AG = path.join(ROOT, 'agents', 'agent44-audit-scoperta.js');
  const visti = new Set();
  const vietati = [];
  const PERICOLOSI = /(venues\/[\w-]+\/adapter|maker\/manual-order|maker\/bulk-allocate|maker\/cancel-all|maker\/allocation-reset|maker\/auto-reprice|maker\/mm-tracking|key-custody|cancel-creds-provider|signer)/;
  const cammina = (f, prof) => {
    if (prof > 6 || visti.has(f)) return;
    visti.add(f);
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { return; }
    // Le STRINGHE non sono import: in questo repo c'è già un runner che contiene un `require(...)`
    // dentro una costante di testo, e un walker ingenuo ci era cascato (CLAUDE.md §5 punto 14).
    const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const re = /require\((['"])([^'"]+)\1\)/g;
    let m;
    while ((m = re.exec(codice))) {
      const spec = m[2];
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      let r;
      try { r = require.resolve(path.resolve(path.dirname(f), spec)); } catch { continue; }
      if (r.includes('node_modules')) continue;
      const rel = path.relative(ROOT, r);
      if (PERICOLOSI.test(rel)) vietati.push(`${path.relative(ROOT, f)} → ${rel}`);
      cammina(r, prof + 1);
    }
  };
  cammina(AG, 0);
  ok('nessun modulo che sa piazzare o cancellare è raggiungibile da agent44',
    vietati.length === 0, vietati.length ? vietati.join(' | ') : `${visti.size} moduli visitati`);

  const src = fs.readFileSync(AG, 'utf8');
  const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('non firma niente', !/signTypedData|_signTypedData|privateKey|PRIVATE_KEY/.test(codice));
  ok('non fa rete', !/https?\.request|fetch\(|axios/.test(codice));
  ok('scrive SOLO la propria coda', (() => {
    const scritture = codice.match(/(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync)\s*\(/g) || [];
    // Una sola scrittura diretta (il markdown); il json passa da coda.scriviCoda.
    return scritture.length === 1 && /CODA_MD/.test(codice);
  })(), 'il json passa da coda.scriviCoda, il markdown è l unica scrittura diretta');
  ok('dichiara i quattro tetti, e li applica da sé',
    /os\.setPriority/.test(codice) && /ionice/.test(codice)
    && /DEADLINE_MS/.test(codice) && /RSS_MAX_MB/.test(codice));
  ok('l ambiente dei test figli è ripulito dalle variabili che aprono il venue',
    /delete env\[k\]/.test(codice) && /MANUAL_ORDER_PLACEMENT/.test(codice) && /MAKER_MODE: 'off'/.test(codice));
}

console.log(`\naudit di scoperta: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

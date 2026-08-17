#!/usr/bin/env node
'use strict';
// lib/maker/cablaggio-di-produzione.test.js — IL BANCO DEVE PROVARE IL CABLAGGIO DI PRODUZIONE.
//
// ═══ IL NUMERO CHE HA FATTO BUTTARE UN NUMERO ════════════════════════════════════════════════════════
// Il 17 agosto 2026 il banco dichiarava «37 regole su 91 arrivano a scattare». Misurato: quel banco NON
// chiamava `agent40.closeTask()` — ricablava `runAutoCloseCycle` da se', con **17 dep contro le 20** che
// la produzione passa. Le 7 mancanti (`registraResiduo`, `rimpiazzaGamba`, `mercatiDaRipianificare`,
// `scadenzaMercato`, `pulisciMercatoChiuso`, `tettoMercato`, `capitaleLibero`) sono esattamente i pezzi
// del fill parziale, della rotazione dello slot e della scadenza del mercato. Il banco misurava un
// auto-close che questo bot non ha, e l'operatore ha buttato il conteggio.
//
// La causa a monte NON era pigrizia del banco: `closeTask()` chiama `resolveMarketRules(marketId)` senza
// `deps`, e quel lettore aveva i due percorsi del feed CABLATI (`/tmp/clob-live-books.json`,
// `/tmp/liquidity-rewards.json`), file che scrive il live agent34 — riscritto ogni ~6 secondi. Il banco
// non poteva possedere la fonte dei prezzi, quindi non poteva chiamare la funzione di produzione.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1 · i due percorsi del feed hanno UNA definizione, risolta a ogni lettura, sovrascrivibile;
//   2 · i cinque moduli che li usavano la importano, e nessuno ridichiara il letterale;
//   3 · le due porte di produzione sono raggiungibili: `agent41.giro` e `agent40.closeTask` esportate;
//   4 · il banco le CHIAMA e non ha un cablaggio proprio di `runAutoCloseCycle` — che e' la proprieta'
//       per cui questo file esiste: un banco che ricabla misura la propria copia.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};
const ROOT = path.join(__dirname, '..', '..');
const senzaCommenti = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const codiceDi = (rel) => senzaCommenti(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

console.log('\n══ 1 · UNA SOLA DEFINIZIONE DEI DUE PERCORSI DEL FEED');
{
  const P = require('./percorsi-feed');
  // ⚠ SI DIFENDE LA PROPRIETA', NON IL VALORE — 17 agosto 2026. Qui c'erano i due letterali
  // `/tmp/clob-live-books.json` e `/tmp/liquidity-rewards.json`, e il 17 agosto la directory di
  // servizio e' passata a `/tmp/rewards-bot-<utente>` (i file di `/tmp` erano di `root`, non
  // riscrivibili e non cancellabili). Il test e' diventato rosso pur essendo il CODICE a essere
  // corretto: e' la classe «test che fotografa il valore invece della proprieta'» (§5.3).
  // La proprieta' vera e' che `percorsi-feed` non ridichiari i percorsi ma li prenda dalla definizione
  // unica — e che i NOMI dei due file non cambino, perche' e' il nome che lettori e scrittori
  // condividono. Cosi' il test cade se qualcuno ricopia un percorso, non se la directory si sposta.
  const { fileRuntime } = require('../percorsi-runtime');
  ok('il difetto viene dalla definizione unica, non da un letterale ricopiato',
    P.fileBookVivi({}) === fileRuntime('clob-live-books.json')
    && P.fileBoardNormalizzato({}) === fileRuntime('liquidity-rewards.json'),
    `${path.basename(P.fileBookVivi({}))} · ${path.basename(P.fileBoardNormalizzato({}))}`);
  ok('  e i NOMI dei due file non sono cambiati (li condividono lettori e scrittori)',
    path.basename(P.fileBookVivi({})) === 'clob-live-books.json'
    && path.basename(P.fileBoardNormalizzato({})) === 'liquidity-rewards.json');
  ok('l\'env sovrascrive', P.fileBookVivi({ MAKER_FEED_BOOKS_FILE: '/x/b.json' }) === '/x/b.json'
    && P.fileBoardNormalizzato({ MAKER_FEED_BOARD_FILE: '/x/n.json' }) === '/x/n.json');
  // Un percorso di soli spazi non e' un percorso: vale come assente, come il perno live-min.
  ok('  env vuota o di soli spazi ⇒ produzione', P.fileBookVivi({ MAKER_FEED_BOOKS_FILE: '   ' }) === P.PRODUZIONE.bookVivi);
  ok('si risolve A OGNI CHIAMATA, non al caricamento del modulo', (() => {
    const prima = P.fileBookVivi({ MAKER_FEED_BOOKS_FILE: '/a.json' });
    const dopo = P.fileBookVivi({ MAKER_FEED_BOOKS_FILE: '/b.json' });
    return prima === '/a.json' && dopo === '/b.json';
  })(), 'un controllo che ha bisogno di un riavvio non e\' un controllo');
  ok('e il dirottamento si DICHIARA', P.dirottati({ MAKER_FEED_BOOKS_FILE: '/x/b.json' }).length === 1
    && P.dirottati({}).length === 0);
}

console.log('\n══ 2 · I CINQUE MODULI PASSANO DA LI\', E NESSUNO RIDICHIARA IL LETTERALE');
{
  const moduli = ['lib/maker/manual-order.js', 'lib/maker/market-clock.js', 'lib/maker/operator-board.js',
    'agents/agent34-clob-ws.js'];
  for (const m of moduli) {
    const c = codiceDi(m);
    ok(`${m} importa percorsi-feed`, /require\((?:'|")(?:\.\.?\/)*(?:lib\/maker\/)?percorsi-feed(?:'|")\)/.test(c));
  }
  // ⚠ Si cerca il LETTERALE nel codice, non nei commenti: un commento che racconta il percorso vecchio
  // non lo reintroduce, e senza il filtro questo test sarebbe verde solo finche' nessuno documenta.
  const colpevoli = [];
  for (const m of [...moduli, 'lib/maker/percorsi-feed.js']) {
    const c = codiceDi(m);
    const n = (c.match(/'\/tmp\/(clob-live-books|liquidity-rewards)\.json'/g) || []).length;
    if (n && m !== 'lib/maker/percorsi-feed.js') colpevoli.push(`${m} (${n})`);
  }
  ok('nessun modulo ridichiara i due percorsi', colpevoli.length === 0, colpevoli.join(', ') || 'zero letterali fuori da percorsi-feed');
  // E la definizione unica c'e' davvero: se sparisse, il test sopra sarebbe verde per assenza.
  ok('  e i due letterali vivono in percorsi-feed', /clob-live-books\.json/.test(codiceDi('lib/maker/percorsi-feed.js'))
    && /liquidity-rewards\.json/.test(codiceDi('lib/maker/percorsi-feed.js')));
}

console.log('\n══ 3 · LE DUE PORTE DI PRODUZIONE SONO RAGGIUNGIBILI');
{
  // ⚠ Si guardano le ESPORTAZIONI nel sorgente e non si carica agent34: caricare un agent che apre un
  // websocket dentro un test e' un effetto collaterale che nessuno ha chiesto.
  const a41 = codiceDi('agents/agent41-realloc-scheduler.js');
  const a40 = codiceDi('agents/agent40-manual-reprice.js');
  ok('agent41 esporta `giro` — il ciclo da 6 ore', /module\.exports = \{ giro,/.test(a41));
  ok('agent40 esporta `closeTask` — il ciclo di chiusura', /module\.exports = \{[^}]*\bcloseTask\b/.test(a40));
  ok('  e la firma di `giro` non e\' cambiata (nessuna dep nuova da tenere allineata)',
    /async function giro\(motivoAvvio\)/.test(a41));
}

console.log('\n══ 4 · IL BANCO CHIAMA LE PORTE DI PRODUZIONE E NON HA UN CABLAGGIO PROPRIO');
{
  const b = codiceDi('scripts/ricerca/banco-scenari.js');
  ok('il banco chiama `closeTask` di agent40', /A40\.closeTask\(/.test(b));
  ok('il banco chiama `giro` di agent41', /A41\.giro\(/.test(b));
  // ⚠ LA PROPRIETA' CHE CONTA, e va asserita per ASSENZA: se il banco chiama `runAutoCloseCycle` da se',
  // sta ricablando — e un cablaggio proprio puo' essere piu' piccolo di quello vero senza che nessuno lo
  // noti. E' esattamente il difetto che ha prodotto «37 su 91».
  ok('il banco NON ricabla `runAutoCloseCycle`', !/runAutoCloseCycle\(/.test(b),
    'il cablaggio dell\'auto-close deve venire da agent40.closeTask, non dal banco');
  ok('  ne\' `runReallocCycle`', !/runReallocCycle\(/.test(b));
}

console.log(`\ncablaggio di produzione: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

'use strict';

/**
 * IL RIAVVIO AUTOMATICO CONDIZIONATO — il caso «una condizione manca quindi NON riavvia» è il cuore.
 * Una modifica inattiva è un costo; un riavvio fatto senza le prove è un rischio sul capitale.
 */

const assert = require('assert');
const RC = require('./riavvio-condizionato');

let passati = 0; let falliti = 0;
const ok = (nome, fn) => { try { fn(); passati += 1; } catch (e) { falliti += 1; console.error(`  ✗ ${nome}\n    ${e.message}`); } };

const buone = () => ({
  suite: { eseguita: true, rossi: [...RC.BASELINE_ROSSI] },
  build: { verde: true },
  kill: { effectivelyKilled: false, readable: true },
  posizioni: { readable: true, scoperteSopraMinimo: 0 },
});

console.log('§1 · le quattro condizioni');

ok('tutte e quattro ⇒ si riavvia', () => assert.strictEqual(RC.valutaCondizioni(buone()).ok, true));

ok('OGNI singola condizione mancante ferma il riavvio, una per una', () => {
  const guasti = {
    suite: { eseguita: true, rossi: [...RC.BASELINE_ROSSI, 'lib/nuovo.test.js'] },
    build: { verde: false },
    kill: { effectivelyKilled: true, readable: true },
    posizioni: { readable: true, scoperteSopraMinimo: 1 },
  };
  for (const [nome, valore] of Object.entries(guasti)) {
    const v = RC.valutaCondizioni({ ...buone(), [nome]: valore });
    assert.strictEqual(v.ok, false, `${nome} mancante deve fermare il riavvio`);
    assert.ok(v.mancanti.includes(nome), `e ${nome} deve comparire fra i mancanti`);
    assert.ok(/RIAVVIO AUTOMATICO NON ESEGUITO/.test(v.riga) && /INATTIVA/.test(v.riga),
      'e la riga deve dire che la modifica resta inattiva');
  }
});

ok('una condizione NON VERIFICABILE vale «no», non «sì»', () => {
  for (const [nome, valore] of Object.entries({
    suite: { eseguita: false }, kill: { readable: false }, posizioni: { readable: false }, build: null,
  })) {
    assert.strictEqual(RC.valutaCondizioni({ ...buone(), [nome]: valore }).ok, false, `${nome} non verificabile`);
  }
});

ok('i nove rossi preesistenti non fermano niente, uno NUOVO sì', () => {
  assert.strictEqual(RC.valutaCondizioni(buone()).ok, true);
  assert.strictEqual(RC.BASELINE_ROSSI.length, 9);
  const v = RC.valutaCondizioni({ ...buone(), suite: { eseguita: true, rossi: ['lib/maker/x.test.js'] } });
  assert.strictEqual(v.ok, false, 'un rosso diverso dai noti è una regressione anche se sono meno di nove');
});

console.log('§2 · la cascata');

ok('sequenziale, mai simultanea, dal più lontano dal capitale al più vicino', () => {
  assert.deepStrictEqual(RC.ORDINE, ['agent24-liquidity-rewards', 'agent41-realloc-scheduler', 'agent40-manual-reprice']);
});

ok('se uno non torna su, gli altri NON vengono riavviati', async () => {
  const visti = [];
  const r = await RC.riavviaInSequenza({
    riavvia: async (n) => { visti.push(n); },
    stato: async (n) => (n === RC.ORDINE[1] ? { online: false } : { online: true, pid: 1, uptimeMs: 30_000, restarts: 1 }),
    attende: async () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.ok(!visti.includes(RC.ORDINE[2]), 'il terzo agent non deve essere toccato');
});

ok('senza esecutore iniettato non riavvia niente', async () => {
  const r = await RC.riavviaInSequenza({});
  assert.strictEqual(r.ok, false);
});

ok('lo script di cablaggio non riavvia se le condizioni non valgono, e ha una anteprima', () => {
  const src = require('fs').readFileSync(require.resolve('../../scripts/riavvio-automatico.js'), 'utf8');
  assert.ok(/--prova/.test(src), 'deve esistere un modo di guardarlo lavorare senza toccare pm2');
  assert.ok(/if \(!v\.ok\)[\s\S]{0,200}process\.exit\(2\)/.test(src), 'e deve uscire prima di riavviare quando le condizioni mancano');
  assert.ok(!/npm.{0,10}run.{0,10}build/.test(src) && !/find .*test\.js/.test(src),
    'lo script NON deve eseguire suite o build da solo: scriverebbe sul giornale vero');
});

(async () => {
  await new Promise((r) => setTimeout(r, 60));
  const selfOk = await RC.selfcheck();
  ok('il selfcheck del modulo è verde', () => assert.strictEqual(selfOk, true));
  console.log(`\nriavvio-condizionato.test: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})();

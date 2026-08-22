'use strict';
// lib/maker/allarme-guardiano.test.js — 21 agosto 2026.
//
// LE TRE PROPRIETA' DIFESE, e sono tutte «cosa l'avviso NON puo' fare»:
//   ① non puo' ritardare la spazzata: si chiama per ULTIMO
//   ② non puo' farla fallire: un mittente che esplode non cambia l'esito
//   ③ non aggiunge nessuna chiamata nei giri normali: vive solo sul ramo dello scatto
// Piu' la quarta, che e' il motivo per cui esiste: non configurato ⇒ lo DICHIARA invece di tacere.

const assert = require('assert');
const A = require('./allarme-guardiano');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };

console.log('\n════ ① il testo dice cosa è successo e come si riparte ════');
{
  const t = A.componiAvviso({ causa: 'drawdown', motivo: 'superate: percentuale (-7.2% ≤ -5%)',
    pnl: { pnlUsd: -111.77, pnlPct: -7.209845 }, capitale: { totaleUsd: 1438.41 }, baseline: { baselineUsd: 1550.18 },
    ordiniCancellati: 21, mercati: ['a', 'b'], botFermato: true, at: Date.parse('2026-08-20T22:36:02Z') });
  ok('porta il capitale, il riferimento e il PnL', /1438\.41/.test(t) && /1550\.18/.test(t) && /-111\.77/.test(t));
  ok('dice quanti ordini sono stati cancellati', /21/.test(t));
  ok('dice che il bot è su FERMA', /FERMA/.test(t));
  ok('dice COME si riparte — è la riga che accorcia le sei ore', /guardian-state\.json/.test(t) && /avvia/i.test(t));
  ok('  e dichiara che non c\'è riarmo automatico', /[Nn]essun riarmo automatico/.test(t));
  ok('sul drawdown dichiara che le posizioni NON si toccano', /posizioni: NON toccate/.test(t));
  const g = A.componiAvviso({ causa: 'perdita-giornaliera', pnl: { pnlUsd: -100.5 },
    chiusura: { daFondere: 1, daVendere: 2, lasciate: 3 }, botFermato: false });
  ok('sulla perdita giornaliera cambia causa e riporta la chiusura', /REALIZZATA/.test(g) && /1 da fondere/.test(g));
  ok('  e un FERMA non scritto è un allarme dentro l\'allarme', /FERMA NON scritto/.test(g));
  // ⚠ Un numero non leggibile non diventa MAI uno zero: sarebbe un avviso che mente sul capitale.
  const vuoto = A.componiAvviso({});
  ok('un valore assente resta «?», non diventa 0', /\?/.test(vuoto) && !/\$0\.00/.test(vuoto));
}

console.log('\n════ ② non configurato ⇒ non si tenta, e lo si DICHIARA ════');
{
  return (async () => {
    let toccato = false;
    const r = await A.inviaAvviso('x', { token: '', chatId: '', post: () => { toccato = true; } });
    ok('senza chiavi non parte niente', r.inviato === false && toccato === false);
    ok('  e il motivo nomina le due variabili che mancano', /TELEGRAM_BOT_TOKEN/.test(r.motivo) && /TELEGRAM_CHAT_ID/.test(r.motivo));
    const r2 = await A.inviaAvviso('x', { token: 't', chatId: 'c', post: async () => { throw new Error('rete giù'); } });
    ok('un mittente che esplode NON solleva: restituisce un esito', r2.inviato === false && /rete giù/.test(r2.motivo));
    const r3 = await A.inviaAvviso('x', { token: 't', chatId: 'c', post: async () => {} });
    ok('con le chiavi e la rete a posto, parte', r3.inviato === true);
    await terzoBlocco();
    console.log(`\nallarme-guardiano: ${pass} passati, ${fail} falliti`);
    assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);
  })();
}

async function terzoBlocco() {
  console.log('\n════ ③ nel flusso: per ultimo, e senza potere ════');
  const path = require('path');
  const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8');
  // ⚠ Si difende l'ORDINE, non la stringa: l'avviso deve stare DOPO la scrittura del latch, che è
  // l'ultimo dei quattro passi. Se qualcuno lo sposta più in su, questo test cade.
  const iLatch = src.indexOf("comeRiarmare:");
  const iAvviso = src.indexOf('deps.inviaAvviso || inviaAvviso');
  ok('l\'invio sta DOPO la scrittura del latch (che è l\'ultimo dei quattro passi)',
    iLatch > 0 && iAvviso > iLatch, `latch@${iLatch} avviso@${iAvviso}`);
  // ⚠ E vive SOLO dentro `spazzaEFerma`: una sola occorrenza, non una per ramo.
  ok('  ed è cablato in un punto solo', (src.match(/deps\.inviaAvviso \|\| inviaAvviso/g) || []).length === 1);
  // ⚠ Nessuna chiamata nei giri normali: `poll` non lo nomina. Si filtrano i commenti, §5.3.
  const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const dentroPoll = codice.slice(codice.indexOf('async function poll('), codice.indexOf('async function spazzaEFerma('));
  ok('  e `poll` non lo nomina: zero chiamate nei giri che non scattano', !/inviaAvviso/.test(dentroPoll));

  // ② un mittente che esplode non cambia l'esito della spazzata: lo si prova sul flusso VERO.
  const { poll } = require(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'));
  const comune = {
    now: () => Date.parse('2026-08-21T12:00:00Z'),
    stato: null,
    baselineRaw: { v: 2, riferimentoUsd: 1000, at: Date.parse('2026-08-21T11:59:30Z'), baselineUsd: 1000,
      ultimaLettura: { at: Date.parse('2026-08-21T11:59:30Z'), totaleUsd: 1000, saldoUsd: 900, valorePosizioniUsd: 100 } },
    saldo: { usd: 800, affidabile: true, etaMs: 1000, fonte: 'test' },
    // ⚠ §5.2 p.54 (22 agosto 2026): dal controllo di co-temporalita' una lettura senza precedente NON
    // e' misurabile, quindi senza questa riga ogni caso cadrebbe su «capitale-illeggibile» e non
    // proverebbe piu' l'avviso. Stato di REGIME: cassa e posizioni ferme ⇒ le due fonti concordano.
    precedenteFonti: { at: Date.parse('2026-08-21T11:59:30Z'), saldoUsd: 800, posizioni: [] },
    posizioni: { readable: true, ageMs: 1000, positions: [] },
    soglie: { pct: 5, abs: 30 },
    scriviJson: () => {},
    buildCancelCredsProviders: async () => ({}),
    cancelAllOrders: async () => [{ venue: 'polymarket', ok: true, cancelled: 7, markets: [{ market: 'm1' }] }],
    impostaBot: () => ({ ok: true, prima: true }),
    registraCancellazione: () => ({ ok: true }),
    statoConferme: { conferme: 1, primaAt: Date.parse('2026-08-21T11:59:30Z'), ultimaAt: Date.parse('2026-08-21T11:59:30Z'), valoreUsd: -200, saldoLetturaAt: 1 },
  };
  const esplode = await poll({ ...comune, inviaAvviso: async () => { throw new Error('boom'); } });
  ok('con l\'avviso che esplode, lo SCATTO avviene lo stesso', esplode.azione === 'scattato', JSON.stringify(esplode).slice(0, 120));
  ok('  e gli ordini risultano cancellati comunque', esplode.ordiniCancellati === 7, String(esplode.ordiniCancellati));
  ok('  e il bot risulta fermato comunque', esplode.botFermato && esplode.botFermato.ok === true);
  ok('  e il fallimento dell\'avviso è dichiarato nell\'esito', esplode.avviso && esplode.avviso.inviato === false && /boom/.test(esplode.avviso.motivo));

  let visto = null;
  const buono = await poll({ ...comune, inviaAvviso: async (t) => { visto = t; return { inviato: true, motivo: null }; } });
  ok('quando parte, riceve il testo con i numeri dello scatto', buono.azione === 'scattato' && /800/.test(visto) && /1000/.test(visto));
  ok('  e il testo dice come riarmare', /guardian-state\.json/.test(visto));

  // ③ un giro ENTRO soglia non tocca il mittente.
  let chiamato = false;
  const calmo = await poll({ ...comune, saldo: { usd: 1000, affidabile: true, etaMs: 1000, fonte: 'test' },
    precedenteFonti: { at: Date.parse('2026-08-21T11:59:30Z'), saldoUsd: 1000, posizioni: [] },
    statoConferme: null, inviaAvviso: async () => { chiamato = true; return { inviato: true }; } });
  ok('un giro entro soglia non chiama il mittente', calmo.azione === 'entro-soglia' && chiamato === false, calmo.azione);
}

#!/usr/bin/env node
'use strict';
// L'INTERRUTTORE AVVIA/FERMA: quello che deve succedere quando NON si riesce a leggerlo.
//
// Questo flag autorizza spesa reale, quindi la maggior parte di questi test non prova l'accensione:
// prova che ogni forma di dubbio — file assente, JSON rotto, campo del tipo sbagliato, scrittura
// fallita — finisca su FERMO. Un interruttore di sicurezza che in caso di dubbio dice «vai» non è un
// interruttore di sicurezza.

const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./bot-enabled');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-enabled-'));
let seq = 0;
const nuovo = () => path.join(dir, `f${seq++}.json`);
const NOW = 1_786_000_000_000;
const ORA = 3_600_000;

console.log('\n── 1 · IL DUBBIO È SEMPRE «FERMO»');
{
  const f = nuovo();
  const s = B.statoBot({ file: f });
  ok('file mai scritto → fermo', s.enabled === false, s.motivo);
  ok('  e lo distingue da un file rotto (leggibile:true, «mai avviato»)', s.leggibile === true && /mai avviato/.test(s.motivo));
  ok('botAttivo su file assente → false', B.botAttivo({ file: f }) === false);
}
{
  const f = nuovo(); fs.writeFileSync(f, 'non-json{');
  const s = B.statoBot({ file: f });
  ok('JSON rotto → fermo, e leggibile:false', s.enabled === false && s.leggibile === false, s.motivo);
}
for (const cattivo of ['{"enabled":"true"}', '{"enabled":1}', '{"enabled":null}', '{}', '[]', 'null']) {
  const f = nuovo(); fs.writeFileSync(f, cattivo);
  const s = B.statoBot({ file: f });
  ok(`enabled malformato ${cattivo} → fermo`, s.enabled === false && s.leggibile === false);
}
{
  const f = nuovo(); fs.writeFileSync(f, '{"enabled":false}');
  ok('un false esplicito è leggibile e fermo', B.statoBot({ file: f }).enabled === false && B.statoBot({ file: f }).leggibile === true);
}

console.log('\n── 2 · COMMUTAZIONE');
{
  const f = nuovo();
  const r = B.impostaBot({ enabled: true, by: 'test', reason: 'prova', file: f, now: NOW });
  ok('accende', r.ok === true && r.ora === true && B.botAttivo({ file: f }) === true);
  ok('  registra chi e perché', B.statoBot({ file: f }).by === 'test' && B.statoBot({ file: f }).reason === 'prova');
  ok('  e l\'istante', B.statoBot({ file: f }).at === NOW);
  const r2 = B.impostaBot({ enabled: false, by: 'test', file: f, now: NOW + 1000 });
  ok('spegne', r2.ok === true && B.botAttivo({ file: f }) === false);
  ok('  e dice com\'era prima', r2.prima === true);
  ok('enabled non booleano è rifiutato', B.impostaBot({ enabled: 'true', file: f }).ok === false);
  ok('  e non cambia lo stato', B.botAttivo({ file: f }) === false);
}

console.log('\n── 3 · IL REGISTRO DELLE APERTURE (era la rampa: tetto giornaliero rimosso il 9 agosto 2026)');
{
  // Il tetto non esiste piu': questa sezione verifica che il modulo NON limiti nulla e si limiti a
  // ricordare. Chi decide quante aperture concedere e' `utilizzo-capitale.aperturaNuoviMercati`, ed e'
  // provato in apertura-guidata-dal-target.test.js.
  ok('nessuna costante di tetto giornaliero e\' piu\' esportata',
    B.RAMPA_ORE === undefined && B.RAMPA_MAX_MERCATI === undefined && B.rampa === undefined);
  const f = nuovo();
  ok('a bot fermo il registro e\' vuoto', B.apertureDallAvvio({ file: f, now: NOW }).aperti === 0);
  B.impostaBot({ enabled: true, file: f, now: NOW });
  ok('appena acceso: nessuna apertura', B.apertureDallAvvio({ file: f, now: NOW }).aperti === 0);
  for (let i = 0; i < 8; i += 1) B.registraMercatoAperto({ marketId: `0xm${i}`, file: f, now: NOW });
  const r = B.apertureDallAvvio({ file: f, now: NOW + ORA });
  ok('registra OLTRE i vecchi 5 senza limitare', r.aperti === 8, `${r.aperti}`);
  ok('  e il motivo dice che non c\'e\' piu\' un tetto', /nessun tetto giornaliero/.test(r.motivo), r.motivo);
  ok('  e nessun campo puo\' essere letto come residuo', r.residuo === undefined && r.attiva === undefined);
  ok('lo stesso mercato non si conta due volte',
    B.registraMercatoAperto({ marketId: '0xm0', file: f, now: NOW }).giaPresente === true && B.apertureDallAvvio({ file: f, now: NOW }).aperti === 8);
  ok('  e nemmeno con maiuscole diverse',
    B.registraMercatoAperto({ marketId: '0XM1', file: f, now: NOW }).giaPresente === true);
  const dopo = B.apertureDallAvvio({ file: f, now: NOW + 25 * ORA });
  ok('a 25h dall\'avvio il registro non cambia natura', dopo.aperti === 8 && dopo.oreDallAvvio === 25);
}
{
  // Riaccendere AZZERA: il registro deve descrivere la sessione in corso, non una vecchia.
  const f = nuovo();
  B.impostaBot({ enabled: true, file: f, now: NOW });
  for (let i = 0; i < 5; i += 1) B.registraMercatoAperto({ marketId: `0xm${i}`, file: f, now: NOW });
  B.impostaBot({ enabled: false, file: f, now: NOW + ORA });
  ok('spegnendo, l\'elenco resta nel file per il registro', B.statoBot({ file: f }).mercatiDallAvvio.length === 5);
  B.impostaBot({ enabled: true, file: f, now: NOW + 2 * ORA });
  ok('riaccendendo, il registro riparte da zero', B.apertureDallAvvio({ file: f, now: NOW + 2 * ORA }).aperti === 0);
  ok('  e l\'elenco è vuoto', B.statoBot({ file: f }).mercatiDallAvvio.length === 0);
}
{
  const f = nuovo();
  B.impostaBot({ enabled: true, file: f, now: NOW });
  ok('a bot fermo non si registra niente',
    (B.impostaBot({ enabled: false, file: f, now: NOW }), B.registraMercatoAperto({ marketId: '0xz', file: f }).ok === false));
  ok('marketId vuoto è rifiutato', B.registraMercatoAperto({ marketId: '  ', file: f }).ok === false);
}
{
  // Istante di avvio illeggibile: il registro lo DICHIARA invece di inventare un'eta'. Non essendo piu'
  // un cancello, non c'e' piu' una direzione prudente da scegliere — c'e' solo il dato mancante.
  const f = nuovo(); fs.writeFileSync(f, JSON.stringify({ v: 1, enabled: true, at: 'ieri', mercatiDallAvvio: [] }));
  const r = B.apertureDallAvvio({ file: f, now: NOW });
  ok('avvio senza istante leggibile → ore non dichiarate, non zero', r.oreDallAvvio === null && r.aperti === 0);
}

console.log('\n── 4 · ISOLAMENTO: QUESTO MODULO NON PIAZZA E NON CANCELLA');
{
  const src = fs.readFileSync(path.join(__dirname, 'bot-enabled.js'), 'utf8');
  const req = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  ok('i require sono solo fs, path, store, atomicJsonWrite',
    req.every((r) => ['fs', 'path', '../safety/store', '../atomicJsonWrite'].includes(r)), req.join(' '));
  ok('non nomina l\'adapter né manual-order', !/adapter|manual-order/.test(src));
  ok('non contiene la parola cancel', !/cancel/i.test(src.replace(/\/\/.*$/gm, '')));
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// lib/safety/percorsi-critici.test.js — UN CONTROLLO CHE NON SA FALLIRE NON E' UN CONTROLLO.
//
// Questo file non si accontenta di vedere il verdetto verde sulla macchina di oggi: **costruisce ognuno
// dei guasti veri del 17 agosto 2026** in una directory temporanea e pretende che il controllo li veda.
// Poi rimette le cose a posto e pretende che torni verde — perche' un controllo sempre rosso e uno
// sempre verde sono ugualmente inutili, e solo il ritorno al verde distingue i due casi.
//
// Run: node lib/safety/percorsi-critici.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const PC = require('./percorsi-critici');
const { NOMI } = require('../percorsi-runtime');

let p = 0; let f = 0;
const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };

console.log('\n════ percorsi critici ════');

// Un finto repo: radice con package.json, data/, e una directory di servizio separata.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'percorsi-critici-'));
const radice = path.join(base, 'repo');
const dataDir = path.join(radice, 'data');
const runtimeDir = path.join(base, 'servizio');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(radice, 'package.json'), '{"name":"finto"}');
fs.mkdirSync(runtimeDir, { recursive: true });
const deps = () => ({ dataDir, runtimeDir, fileRuntime: (n) => path.join(runtimeDir, n) });

// ── ① IL CASO SANO ────────────────────────────────────────────────────────────────────────────
{
  const v = PC.verifica(deps());
  ok('un repo sano ⇒ verde', v.ok === true, `${v.controllati} controlli, ${v.guasti.length} guasti`);
}

// ── ② UN FILE DI SERVIZIO ASSENTE NON E' UN GUASTO ────────────────────────────────────────────
// E' il primo avvio: i file di servizio non ci sono ancora e verranno creati. Pretenderli farebbe
// fallire ogni accensione da zero — l'errore opposto, e altrettanto costoso.
{
  const v = PC.verifica(deps());
  ok('file di servizio ASSENTI ⇒ ancora verde', v.ok === true,
    'assente ≠ non scrivibile: si controlla che si POSSA scrivere, non che sia gia\' scritto');
}

// ── ③ IL GUASTO VERO DEL 17 AGOSTO: il file c'e', ed e' di un altro ───────────────────────────
// Non si puo' cambiare proprietario senza root, ma il sintomo che conta e' identico: `accessSync(W_OK)`
// fallisce. `chmod 0444` su un file nostro lo riproduce esattamente per un utente non-root.
{
  const vittima = path.join(runtimeDir, NOMI.bookVivi);
  fs.writeFileSync(vittima, '{}');
  fs.chmodSync(vittima, 0o444);
  const v = PC.verifica(deps());
  const g = v.guasti.find((x) => x.percorso === vittima);
  ok('un file di servizio ESISTENTE e non scrivibile ⇒ ROSSO', v.ok === false && !!g,
    g ? g.cosa : 'NESSUN GUASTO RILEVATO — il controllo non vedrebbe il guasto del 17 agosto');
  ok('  e il motivo dice la conseguenza, non solo il permesso',
    !!g && /non invecchia piu|in silenzio/.test(g.perche));
  fs.chmodSync(vittima, 0o644);
  ok('  rimesso scrivibile ⇒ torna verde', PC.verifica(deps()).ok === true,
    'un controllo sempre rosso non distingue niente');
  fs.unlinkSync(vittima);
}

// ── ④ `data/` NON SCRIVIBILE ──────────────────────────────────────────────────────────────────
{
  fs.chmodSync(dataDir, 0o555);
  const v = PC.verifica(deps());
  const g = v.guasti.find((x) => x.percorso === dataDir);
  ok('`data/` non scrivibile ⇒ ROSSO', v.ok === false && !!g, g ? g.perche.slice(0, 60) : 'non visto');
  fs.chmodSync(dataDir, 0o755);
  ok('  rimessa scrivibile ⇒ torna verde', PC.verifica(deps()).ok === true);
}

// ── ⑤ `data/` ASSENTE ─────────────────────────────────────────────────────────────────────────
{
  const altro = path.join(base, 'senza-data');
  fs.mkdirSync(altro, { recursive: true });
  fs.writeFileSync(path.join(altro, 'package.json'), '{}');
  const v = PC.verifica({ dataDir: path.join(altro, 'data'), runtimeDir, fileRuntime: (n) => path.join(runtimeDir, n) });
  ok('`data/` assente ⇒ ROSSO', v.ok === false && v.guasti.some((x) => /directory dei dati/.test(x.cosa)));
}

// ── ⑥ LA RADICE SENZA `package.json` — cioe' DATA_DIR ancorato male ───────────────────────────
// E' il difetto della migrazione nella sua forma piu' pura: il percorso «esiste» e punta altrove.
{
  const finta = path.join(base, 'non-un-repo');
  fs.mkdirSync(path.join(finta, 'data'), { recursive: true });
  const v = PC.verifica({ dataDir: path.join(finta, 'data'), runtimeDir, fileRuntime: (n) => path.join(runtimeDir, n) });
  ok('radice senza package.json ⇒ ROSSO', v.ok === false && v.guasti.some((x) => /radice/.test(x.cosa)),
    'e\' il difetto della migrazione: un percorso che esiste e punta altrove');
}

// ── ⑦ LA DIRECTORY DI SERVIZIO SI CREA DA SOLA ────────────────────────────────────────────────
{
  const nuova = path.join(base, 'servizio-nuovo', 'annidata');
  const v = PC.verifica({ dataDir, runtimeDir: nuova, fileRuntime: (n) => path.join(nuova, n) });
  ok('una directory di servizio inesistente viene CREATA, non dichiarata rotta', v.ok === true,
    'il primo avvio su una macchina pulita deve funzionare');
}

// ── ⑧ `verificaOMuori` ESCE DAVVERO, E LO DICE ────────────────────────────────────────────────
// Si iniettano `exit` e `stderr`: il test non puo' morire per provare che il codice muore.
{
  const vittima = path.join(runtimeDir, NOMI.battiti);
  fs.writeFileSync(vittima, '{}');
  fs.chmodSync(vittima, 0o444);
  let uscita = null; let testo = '';
  PC.verificaOMuori('agent-finto', { ...deps(), exit: (c) => { uscita = c; }, stderr: (s) => { testo += s; } });
  ok('su guasto: esce con codice 1', uscita === 1);
  ok('  e stampa CHI si e\' fermato e SU QUALE percorso', /agent-finto/.test(testo) && testo.includes(vittima));
  ok('  e dice perche\' fermarsi e\' voluto', /voluto/.test(testo));
  fs.chmodSync(vittima, 0o644);
  let uscita2 = null;
  PC.verificaOMuori('agent-finto', { ...deps(), exit: (c) => { uscita2 = c; }, stderr: () => {} });
  ok('  e su repo sano NON esce', uscita2 === null);
  fs.unlinkSync(vittima);
}

// ── ⑨ IL CABLAGGIO: gli agent che scrivono file di servizio lo chiamano davvero ────────────────
// ⚠ E' LA META' CHE MANCAVA ALLE TRE DIFESE INERTI (§5-bis p.181): quei test provavano la DECISIONE e
// non il CABLAGGIO, ed erano verdi mentre la difesa non girava. Qui si legge il sorgente degli agent.
{
  const ROOT = path.resolve(__dirname, '..', '..');
  const attesi = ['agent24-liquidity-rewards', 'agent27-news-guard', 'agent34-clob-ws',
    'agent38-tape-watchdog', 'agent40-manual-reprice', 'agent41-realloc-scheduler',
    'agent43-guardian', 'agent45-osservatore', 'agent-monitor'];
  const senza = [];
  for (const a of attesi) {
    let src = '';
    try { src = fs.readFileSync(path.join(ROOT, 'agents', `${a}.js`), 'utf8'); } catch { senza.push(`${a} (file assente)`); continue; }
    const codice = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/verificaOMuori\s*\(/.test(codice)) senza.push(a);
  }
  ok('ogni agent che scrive file di servizio chiama `verificaOMuori` all\'avvio', senza.length === 0,
    senza.length ? `senza il controllo: ${senza.join(', ')}` : `${attesi.length} agent`);
}

try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* pazienza */ }
console.log(`\npercorsi critici: ${p} verdi, ${f} rossi`);
process.exit(f === 0 ? 0 : 1);

'use strict';
// lib/maker/saldo-da-cache-non-da-dashboard.test.js — AGENT41 LEGGE IL SALDO DALLA CACHE IN PROCESSO.
//
// ═══ IL DIFETTO, MISURATO ════════════════════════════════════════════════════════════════════════════
// `agent41.leggiSaldo` faceva `GET http://127.0.0.1:3000/api/rewards/balance`. Il `dashboard` e' uscito
// dalla flotta il 15 agosto 2026, quindi ogni giro riceveva ECONNREFUSED e il log diceva
//   «tetto per mercato $24.5 DERIVATO da capitale $0.00 · 0 mercati sostenibili»
// mentre agent40, nello stesso istante e sulla stessa macchina, leggeva **$1.499,64** da `saldo-cache`.
// Il bot non poteva pianificare niente, e il fallimento era MUTO: `readable:false` e' un esito ordinario.
//
// ═══ COSA SI DIFENDE ═════════════════════════════════════════════════════════════════════════════════
//  1. l'IMPORT PER NOME. E' la classe «dep non cablata» di §5.3 (sesta occorrenza in §5-bis p.153): se
//     `leggiSaldoUsd` sparisse dalla destrutturazione, il `try` dentro `leggiSaldo` restituirebbe
//     `readable:false` e il bot pianificherebbe su capitale zero **in silenzio**. Un test che chiama la
//     funzione con la cache finta non lo prenderebbe: prenderebbe la propria finta.
//  2. che NESSUNA fetch al dashboard sia rimasta — filtrando commenti, o l'header che RACCONTA la riga
//     vecchia farebbe passare il test da solo (§5.3).
//  3. il FAIL-CLOSED nelle tre forme in cui puo' fallire, che e' la meta' che conta: `affidabile:false`
//     non deve mai far passare il numero, nemmeno quando un `usd` c'e'.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

const SORGENTE = path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js');
const testo = fs.readFileSync(SORGENTE, 'utf8');
// Via i commenti PRIMA di cercare qualunque cosa: un commento che racconta la riga corretta ha gia'
// fatto passare un test che cercava la stringa nel sorgente.
const codice = testo
  .split('\n')
  .map((r) => r.replace(/\/\/.*$/, ''))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n════ agent41 legge il saldo dalla cache, non dal dashboard ════');

// ── 1 · IL FILO ───────────────────────────────────────────────────────────────────────────────────
ok('`leggiSaldoUsd` e\' IMPORTATA per nome da lib/maker/saldo-cache',
  /const\s*\{[^}]*\bleggiSaldoUsd\b[^}]*\}\s*=\s*require\(\s*['"][^'"]*maker\/saldo-cache['"]\s*\)/.test(codice));
ok('  e viene davvero CHIAMATA dentro `leggiSaldo`',
  /async function leggiSaldo\s*\([\s\S]{0,600}?leggiSaldoUsd\s*\(/.test(codice));

// ── 2 · IL DASHBOARD NON C'E' PIU' ────────────────────────────────────────────────────────────────
ok('nessuna costante DASHBOARD nel codice', !/\bconst\s+DASHBOARD\b/.test(codice));
ok('nessun 127.0.0.1:3000 nel codice', !/127\.0\.0\.1:3000/.test(codice));
ok('nessuna fetch a /api/rewards/balance nel codice', !/api\/rewards\/balance/.test(codice));
ok('  (e i commenti che RACCONTANO la riga vecchia esistono ancora: il filtro funziona)',
  /127\.0\.0\.1:3000/.test(testo));

// ── 3 · IL CONTRATTO, PROVATO SULLA FUNZIONE VERA CON UNA CACHE INIETTATA ─────────────────────────
// Si ricarica il modulo con `saldo-cache` sostituito nella require cache: cosi' si esercita il codice
// VERO di `leggiSaldo`, non una copia.
const percorsoCache = require.resolve('./saldo-cache');
const veroCache = require(percorsoCache);
const conCache = async (risposta) => {
  delete require.cache[require.resolve(SORGENTE)];
  require.cache[percorsoCache] = { id: percorsoCache, filename: percorsoCache, loaded: true,
    exports: { ...veroCache, leggiSaldoUsd: async () => risposta } };
  const m = require(SORGENTE);
  const r = await m.leggiSaldo();
  delete require.cache[require.resolve(SORGENTE)];
  require.cache[percorsoCache] = { id: percorsoCache, filename: percorsoCache, loaded: true, exports: veroCache };
  return r;
};

(async () => {
  const buono = await conCache({ usd: 1499.64, funder: '0xabc', etaMs: 1200, affidabile: true, fonte: 'cache', motivo: null });
  ok('saldo affidabile ⇒ readable con il numero e l\'eta\'',
    buono.readable === true && buono.usd === 1499.64 && buono.ageSeconds === 1);

  // ⚠ IL CASO CHE CONTA: la cache HA un numero e lo dichiara comunque inaffidabile.
  const scaduto = await conCache({ usd: 1499.64, funder: '0xabc', etaMs: 900_000, affidabile: false, fonte: 'cache-scaduta', motivo: 'saldo in cache vecchio di 900s' });
  ok('saldo NON affidabile ⇒ readable:false ANCHE se un numero c\'e\'',
    scaduto.readable === false && scaduto.usd === undefined);
  ok('  e il motivo della cache viene riportato, non inghiottito',
    /vecchio di 900s/.test(scaduto.error || ''));

  const mai = await conCache({ usd: null, funder: null, etaMs: null, affidabile: false, fonte: 'nessuna', motivo: 'saldo mai letto' });
  ok('saldo mai letto ⇒ readable:false — sconosciuto NON e\' zero', mai.readable === false && mai.usd === undefined);

  const nulla = await conCache(null);
  ok('lettore senza risposta ⇒ readable:false', nulla.readable === false);

  // Un `affidabile:true` con un `usd` non finito e' incoerente: si rifiuta invece di fidarsi del flag.
  const incoerente = await conCache({ usd: null, affidabile: true, fonte: 'cache', motivo: null });
  ok('affidabile:true ma usd non finito ⇒ readable:false (il flag non basta)', incoerente.readable === false);

  // Un'eccezione del lettore non deve propagarsi: il ciclo la vedrebbe come un crash, non come un dato.
  delete require.cache[require.resolve(SORGENTE)];
  require.cache[percorsoCache] = { id: percorsoCache, filename: percorsoCache, loaded: true,
    exports: { ...veroCache, leggiSaldoUsd: async () => { throw new Error('catena giu\''); } } };
  const esploso = await require(SORGENTE).leggiSaldo();
  delete require.cache[require.resolve(SORGENTE)];
  require.cache[percorsoCache] = { id: percorsoCache, filename: percorsoCache, loaded: true, exports: veroCache };
  ok('un\'eccezione del lettore diventa readable:false, non un crash del ciclo',
    esploso.readable === false && /catena giu/.test(esploso.error || ''));

  console.log(`\nsaldo-da-cache-non-da-dashboard: ${p} passati, 0 falliti`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });

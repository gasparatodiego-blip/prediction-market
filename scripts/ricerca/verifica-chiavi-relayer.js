#!/usr/bin/env node
'use strict';
/**
 * LE CHIAVI DEL RELAYER, PROVATE — SOLA LETTURA, NESSUN MERGE.
 *
 * ⚠ COSA FA E COSA NON FA. L'unica chiamata di rete e' una **GET** —
 * `/v1/account/transactions/params` via `ctf-relayer.leggiNonce` — che autentica con la chiave e legge
 * il nonce dell'account. Non firma niente, non costruisce nessun batch, non tocca `mergePosition`,
 * `splitPosition` ne' `redeemPosition`. Se la chiave e' sbagliata il relayer risponde 401/403 e lo si
 * scopre senza aver speso gas ne' aver mosso una posizione.
 *
 * ⚠ E CARICA `.env` COME LO CARICA agent40, non come farebbe uno script qualunque: quel processo ha un
 * caricatore scritto a mano (riga 57) che riempie solo le chiavi ASSENTI. E' il motivo per cui
 * `/proc/<pid>/environ` mostra ZERO occorrenze della chiave pur essendo il processo perfettamente
 * capace di leggerla: /proc fotografa l'ambiente all'EXEC, non quello che il processo si costruisce
 * dopo. Verificare da /proc risponderebbe a una domanda diversa da quella posta.
 *
 * Uso:  node scripts/ricerca/verifica-chiavi-relayer.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Lo STESSO caricatore di agent40, copiato nella forma e non nell'intenzione: riempie solo le chiavi
// assenti, cosi' un env gia' presente vince — che e' esattamente la regola dei processi.
for (const f of ['.env.local', '.env']) {
  try {
    for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file assente: si prosegue */ }
}

const REL = require(path.join(ROOT, 'lib', 'maker', 'ctf-relayer'));

const mask = (v) => (typeof v === 'string' && v.length > 10 ? `${v.slice(0, 6)}…${v.slice(-4)}` : (v ? '(corta)' : '(vuota)'));
let rossi = 0;
const ok = (n, c, x) => { if (!c) rossi++; console.log(`  ${c ? '✓' : '✗'} ${n}${x ? ' — ' + x : ''}`); };

(async () => {
  console.log('\n════ LE CHIAVI DEL RELAYER — sola lettura ════\n');

  // ── 1 · I NOMI ────────────────────────────────────────────────────────────────────────────────
  const key = (process.env.POLYMARKET_RELAYER_API_KEY || '').trim();
  const addr = (process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS || '').trim();
  console.log('1 · i nomi che il codice legge (ctf-relayer.js:199-200)');
  ok('POLYMARKET_RELAYER_API_KEY presente', !!key, mask(key));
  ok('POLYMARKET_RELAYER_API_KEY_ADDRESS presente', !!addr, mask(addr));
  ok('  l\'indirizzo ha la forma di un indirizzo', /^0x[0-9a-fA-F]{40}$/.test(addr), addr ? `${addr.length} caratteri` : '—');

  // ── 2 · LA FUNZIONE VERA CHE LE LEGGE ─────────────────────────────────────────────────────────
  console.log('\n2 · `credenziali()` — la funzione che il merge chiama davvero');
  // ⚠ IL NOME DELL'OPERAZIONE E' QUELLO DELL'ABI, non una parola nostra: `mergePositions`, non
  // «merge». Con il nome sbagliato ethers solleva `unknown function` — che e' un errore del test, non
  // delle credenziali, e confonderli avrebbe fatto dichiarare rotta una chiave buona.
  let cred = null;
  try {
    const op = REL.mostraOperazione({ operazione: 'mergePositions', conditionId: '0x' + '11'.repeat(32),
      negRisk: false, quantita: 1 });
    ok('le credenziali si risolvono e l\'operazione si costruisce', !!op);
    ok('  e il signer che ne esce è l\'indirizzo della chiave',
      JSON.stringify(op).toLowerCase().includes(addr.toLowerCase()), mask(addr));
  } catch (e) {
    ok('le credenziali si risolvono e l\'operazione si costruisce', false, String(e && e.message).slice(0, 140));
  }
  // ⚠ LE CREDENZIALI SI COSTRUISCONO A PARTE, e non dentro il `try` di sopra: legarle a quel blocco
  // significava che un errore di COSTRUZIONE dell'operazione lasciava `cred` a null e faceva fallire
  // la chiamata di rete con «Cannot read properties of null» — cioe' una diagnosi che punta al posto
  // sbagliato. Sono due domande diverse e vogliono due blocchi diversi.
  try { cred = { key, address: addr }; } catch { cred = null; }

  // ── 3 · L'INTERRUTTORE ────────────────────────────────────────────────────────────────────────
  console.log('\n3 · l\'interruttore del relayer');
  ok('CTF_RELAYER_ENABLED è acceso', REL.CTF_RELAYER_ENABLED === true, String(REL.CTF_RELAYER_ENABLED));

  // ── 4 · LA PROVA VERA: UNA GET ────────────────────────────────────────────────────────────────
  console.log('\n4 · la chiamata di verifica — GET /v1/account/transactions/params');
  console.log('    ⚠ nessuna firma, nessun batch, nessun merge: legge solo il nonce dell\'account.');
  if (!key || !addr) {
    console.log('    saltata: senza credenziali non c\'è niente da provare.');
  } else {
    try {
      const r = await REL.leggiNonce({ signer: addr, cred });
      ok('il relayer ha risposto e la chiave è ACCETTATA', /^\d+$/.test(String(r.nonce)),
        `nonce ${r.nonce}${r.indirizzoEffimero ? ` · address ${mask(r.indirizzoEffimero)}` : ''}`);
    } catch (e) {
      ok('il relayer ha risposto e la chiave è ACCETTATA', false, String(e && e.message).slice(0, 200));
    }
  }

  console.log(`\n${rossi === 0 ? '✅ tutte verdi' : `❌ ${rossi} verifiche rosse`}\n`);
  process.exit(rossi === 0 ? 0 : 1);
})();

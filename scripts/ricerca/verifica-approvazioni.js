#!/usr/bin/env node
'use strict';
/**
 * LE APPROVAZIONI ON-CHAIN, LETTE DALLA CATENA — sola lettura, nessuna transazione.
 *
 * ⚠ PERCHE' SERVE. `MAKER_FUNDING_APPROVED=true` e' un'ATTESTAZIONE UMANA, non una verifica: dice
 * «qualcuno afferma che il wallet e' finanziato e le approvazioni ci sono». Il codice si fida di
 * quella parola e non guarda la catena. Questo script guarda la catena.
 *
 * Due cose vanno concesse, e sono diverse:
 *   · ERC-20  — l'`allowance` del collaterale pUSD verso i due exchange: senza, un BUY non puo' pagare;
 *   · ERC-1155 — `isApprovedForAll` sui ConditionalTokens verso gli stessi due: senza, un SELL non puo'
 *     consegnare le share e il merge non puo' spendere la coppia.
 * Mancarne una sola produce un rifiuto del venue che NON nomina l'approvazione, ed e' il modo peggiore
 * di scoprirlo — a ordine gia' firmato.
 *
 * ⚠ SI GUARDA IL FUNDER, NON L'EOA. Con `MAKER_SIGNATURE_TYPE=3` il maker e' il deposit wallet
 * (contratto ERC-1271): e' LUI a possedere collaterale e share, e sono le SUE approvazioni a contare.
 * Controllare l'EOA risponderebbe a una domanda diversa da quella posta — lo stesso errore di quando
 * si legge `/proc` invece dell'ambiente costruito dal processo.
 *
 * Uso:  node scripts/ricerca/verifica-approvazioni.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

for (const f of ['.env.local', '.env']) {
  try {
    for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* assente */ }
}

const { JsonRpcProvider, Contract } = require('ethers');

// Gli indirizzi vengono dal codice, non riscritti a mano: una copia divergente qui direbbe che le
// approvazioni ci sono su un exchange che non usiamo.
const REL = require(path.join(ROOT, 'lib/maker/ctf-relayer'));
const EXCHANGES = [
  { nome: 'CTF Exchange v2', addr: REL.ADAPTER_STANDARD },
  { nome: 'Neg-Risk CTF Exchange v2', addr: REL.ADAPTER_NEG_RISK },
];
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

const ABI20 = ['function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
const ABI1155 = ['function isApprovedForAll(address,address) view returns (bool)'];

let rossi = 0;
const ok = (n, c, x) => { if (!c) rossi++; console.log(`  ${c ? '✓' : '✗'} ${n}${x ? ' — ' + x : ''}`); };

(async () => {
  console.log('\n════ APPROVAZIONI ON-CHAIN — sola lettura ════\n');
  const funder = (process.env.MAKER_FUNDER_ADDRESS || '').trim();
  console.log(`funder (deposit wallet): ${funder || '(non impostato)'}`);
  console.log(`attestazione MAKER_FUNDING_APPROVED: ${JSON.stringify(process.env.MAKER_FUNDING_APPROVED || '')}`);
  console.log(`RPC: ${RPC.replace(/\/\/[^@]*@/, '//…@')}\n`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    console.log('  ✗ senza funder non c\'e\' niente da verificare.');
    process.exit(1);
  }

  const p = new JsonRpcProvider(RPC, 137);
  const usd = new Contract(PUSD, ABI20, p);
  const ctf = new Contract(CTF, ABI1155, p);

  try {
    const b = await usd.balanceOf(funder);
    console.log(`  saldo pUSD del funder: $${(Number(b) / 1e6).toFixed(2)}\n`);
  } catch (e) { console.log(`  ⚠ saldo non leggibile: ${String(e.message).slice(0, 80)}\n`); }

  for (const ex of EXCHANGES) {
    console.log(`── ${ex.nome}  ${ex.addr}`);
    try {
      const a = await usd.allowance(funder, ex.addr);
      // Un'allowance «infinita» e' la pratica normale; qui basta che sia largamente sopra il capitale.
      ok('  ERC-20 · allowance pUSD concessa', Number(a) > 0,
        Number(a) > 1e30 ? 'illimitata' : `$${(Number(a) / 1e6).toFixed(2)}`);
    } catch (e) { ok('  ERC-20 · allowance pUSD concessa', false, String(e.message).slice(0, 90)); }
    try {
      const s = await ctf.isApprovedForAll(funder, ex.addr);
      ok('  ERC-1155 · setApprovalForAll sui ConditionalTokens', s === true, String(s));
    } catch (e) { ok('  ERC-1155 · setApprovalForAll sui ConditionalTokens', false, String(e.message).slice(0, 90)); }
  }

  console.log(`\n${rossi === 0
    ? '✅ tutte concesse — l\'attestazione corrisponde alla catena'
    : `❌ ${rossi} approvazioni MANCANTI: l'attestazione MAKER_FUNDING_APPROVED e' piu' ottimista della catena`}\n`);
  process.exit(rossi === 0 ? 0 : 1);
})();

'use strict';
// lib/maker/live-providers.js — the ONE CommonJS provider pair the LIVE maker adapter needs.
//
// Gli agent pm2 sono CommonJS e non possono require() il TypeScript credentials.ts, quindi questo modulo è
// l'equivalente require()-abile di makerProviders: turns stored Prisma custody into the two thunks createMakerAdapter
// calls LAZILY on a live mutating path:
//   credsProvider  → { creds:{key,secret,passphrase}, address }   L2 HMAC — REUSED verbatim from the ONE
//                    cancel creds provider (venue='polymarket'), so post/cancel/list authenticate identically.
//   signerProvider → { privateKey, address }                      the raw signing key (venue='polymarket-maker',
//                    apiSecretEnc) for the L1 EIP-712 order signature.
//
// SECRET HYGIENE: the private key is decrypted ONLY inside signerProvider, for the duration of one call,
// through the ONE crypto path (lib/key-custody). It is NEVER logged, NEVER returned in an error, NEVER
// printed. key-custody is required LAZILY so importing this module cannot trip its fail-closed import-throw
// before an agent has loaded its .env. This module ADDS NO gate and REMOVES NONE — the adapter's placement
// gates (mode / funding-approval / kill / caps / venue-rules) are unchanged and still decide every order.

const { polymarketCancelCredsProvider } = require('./cancel-creds-provider');
const { resolveAdminServiceUserId } = require('../admin-service-account');

const MAKER_VENUE = 'polymarket-maker';

let _prisma = null;
function prisma() {
  if (_prisma) return _prisma;
  const g = /** @type {any} */ (global);
  if (g.prisma) { _prisma = g.prisma; return _prisma; }
  const { PrismaClient } = require('@prisma/client');
  _prisma = new PrismaClient();
  return _prisma;
}

async function activeMakerRow() {
  const userId = await resolveAdminServiceUserId(prisma());
  return prisma().exchangeKey.findFirst({
    where: { venue: MAKER_VENUE, revokedAt: null, userId },
    orderBy: { createdAt: 'desc' },
  });
}

/** True iff an active maker SIGNING key is stored. Row presence only — no decryption. */
async function makerSignerAvailable() {
  try { return (await activeMakerRow()) != null; } catch { return false; }
}

/**
 * The signerProvider the maker adapter calls on a live mutating path: async () => ({ privateKey, address }).
 * Decrypts the signing key ON CALL; the plaintext lives only here and the caller (adapter.liveClient) hands
 * it straight to the signing signer and drops the reference. Throws (with NO key material) if none stored.
 */
async function makerSignerProvider() {
  const row = await activeMakerRow();
  if (!row) throw new Error('maker signer: no active polymarket-maker signing key stored (run scripts/polymarket-maker-store-key.ts)');
  if (!row.apiSecretEnc || !row.accountAddress) throw new Error('maker signer: signing-key row is missing required fields');
  const { unwrapDek, decryptField } = require('../key-custody');
  const dek = unwrapDek(row.dekEnc, row.kekVersion);
  try {
    return { privateKey: decryptField(row.apiSecretEnc, dek), address: row.accountAddress };
  } finally {
    dek.fill(0);
  }
}

/**
 * The provider pair for a live maker adapter. credsProvider is the SAME one the cancel path uses (L2);
 * signerProvider yields the raw key. Both are async thunks, called lazily only on a live mutating path.
 */
function makerLiveProviders() {
  return { credsProvider: polymarketCancelCredsProvider, signerProvider: makerSignerProvider };
}

module.exports = { makerLiveProviders, makerSignerProvider, makerSignerAvailable, MAKER_VENUE };

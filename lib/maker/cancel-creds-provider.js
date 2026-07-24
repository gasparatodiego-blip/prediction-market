'use strict';
// lib/maker/cancel-creds-provider.js — the ONE cancel credentials provider.
//
// Reads the L2 Polymarket credentials from Prisma custody (venue='polymarket' ExchangeKey owned by the
// admin service account) and hands them to the cancel-only adapter. Imported by BOTH consumers of the
// cancel path — POST /api/maker/cancel and agent37-maker-watchdog — so there is exactly ONE place that
// turns stored custody into live cancel credentials.
//
// READ-ONLY w.r.t. custody. Decrypted material lives ONLY for the duration of one provider call; it is
// never logged, never returned in an API response, never placed in an error message. Reuses the ONE
// crypto path (lib/key-custody). It CANNOT place an order — it only yields L2 creds to the cancel-only
// adapter (address-only signer). key-custody is required LAZILY (inside the call) so that importing this
// module never triggers key-custody's fail-closed import-throw before an agent has loaded its .env.

const { resolveAdminServiceUserId } = require('../admin-service-account');

const POLY_VENUE = 'polymarket';

let _prisma = null;
function prisma() {
  if (_prisma) return _prisma;
  const g = /** @type {any} */ (global);
  if (g.prisma) { _prisma = g.prisma; return _prisma; } // reuse the app singleton when present
  const { PrismaClient } = require('@prisma/client');
  _prisma = new PrismaClient();
  return _prisma;
}

async function activeRow() {
  const userId = await resolveAdminServiceUserId(prisma());
  return prisma().exchangeKey.findFirst({
    where: { venue: POLY_VENUE, revokedAt: null, userId },
    orderBy: { createdAt: 'desc' },
  });
}

/** True iff an active Polymarket L2 credential is stored. No decryption — row presence only. */
async function cancelCredsAvailable() {
  try {
    return (await activeRow()) != null;
  } catch {
    return false; // custody/DB unreadable → treat as absent (caller falls back to a dry-run cancel)
  }
}

/**
 * The provider the cancel-only adapter calls: async () => ({ creds:{key,secret,passphrase}, address }).
 * Decrypts on call; the plaintext lives only here. Throws (loudly, with NO secret material) if none is
 * stored or custody fails — the caller treats a throw as "creds absent".
 */
async function polymarketCancelCredsProvider() {
  const row = await activeRow();
  if (!row) throw new Error('cancel creds: no active polymarket L2 credential stored');
  if (!row.apiKeyEnc || !row.passphraseEnc || !row.accountAddress) {
    throw new Error('cancel creds: polymarket credential row is missing required fields');
  }
  // Lazy require: only reach the fail-closed crypto module once we genuinely need to decrypt.
  const { unwrapDek, decryptField } = require('../key-custody');
  const dek = unwrapDek(row.dekEnc, row.kekVersion);
  try {
    return {
      creds: {
        key: decryptField(row.apiKeyEnc, dek),
        secret: decryptField(row.apiSecretEnc, dek),
        passphrase: decryptField(row.passphraseEnc, dek),
      },
      address: row.accountAddress,
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Build the per-venue credsProvider map for cancelAllOrders. Returns { polymarket: provider } ONLY when an
 * active credential is actually stored; otherwise {} → cancelAllOrders runs a dry-run (simulated) cancel.
 * This is what makes simulated:true reachable ONLY when credentials are genuinely absent.
 */
async function buildCancelCredsProviders() {
  const providers = {};
  if (await cancelCredsAvailable()) providers[POLY_VENUE] = polymarketCancelCredsProvider;
  return providers;
}

module.exports = { polymarketCancelCredsProvider, cancelCredsAvailable, buildCancelCredsProviders, POLY_VENUE };

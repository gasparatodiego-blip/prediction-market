'use strict';
// lib/admin-service-account.js — the ONE resolver for the admin lane's ExchangeKey ownership.
//
// THE PROBLEM: ExchangeKey.userId is a non-null foreign key to User, but the admin lane authenticates via
// ADMIN_ACCESS_SECRET and has NO next-auth user session. That is the real reason a separate file store
// existed. We solve it properly, not by bypassing the constraint.
//
// THE SOLUTION (Phase 1, option 2): ONE dedicated, login-INCAPABLE service-account User with a
// deterministic id. We deliberately do NOT reuse the existing human admin row (diego+pro@edgeradar.io):
//   • the admin lane must stay decoupled from next-auth identities — coupling admin custody to a real,
//     login-capable account reintroduces exactly the coupling the separate store existed to avoid;
//   • ExchangeKey.user has onDelete: Cascade — if that human row were ever deleted, the maker's keys
//     would be silently cascade-deleted with it. A service account that nothing logs in as is safer.
// It has no passwordHash and no googleId, so no credential or OAuth path can authenticate as it. It
// exists solely to satisfy the foreign key.
//
// CommonJS on purpose: this must be resolvable by BOTH the Next API routes (.ts) AND the plain-node CLI
// scripts AND the node cancel credsProvider — a .js module is the only form all three can import. No
// hardcoded ids anywhere else; every caller resolves through here.

const ADMIN_SERVICE_USER_ID = 'svc-admin-maker';
const ADMIN_SERVICE_EMAIL = 'admin@local.edgeradar';

/**
 * Ensure the admin-lane service-account User exists and return its id. Idempotent (upsert by the
 * deterministic id). Safe to call on every request/run.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<string>}
 */
async function resolveAdminServiceUserId(prisma) {
  await prisma.user.upsert({
    where: { id: ADMIN_SERVICE_USER_ID },
    update: {}, // never mutate an existing row from here
    create: {
      id: ADMIN_SERVICE_USER_ID,
      email: ADMIN_SERVICE_EMAIL,
      role: 'service',                       // not 'user'/'admin' — clearly not a human account
      name: 'Admin lane service account (no login)',
      passwordHash: null,                    // cannot authenticate via credentials
      googleId: null,                        // cannot authenticate via OAuth
    },
  });
  return ADMIN_SERVICE_USER_ID;
}

module.exports = { ADMIN_SERVICE_USER_ID, ADMIN_SERVICE_EMAIL, resolveAdminServiceUserId };

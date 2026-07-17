/**
 * scripts/rotate-kek.ts — re-wrap every ExchangeKey row's DEK from one KEK to
 * another.
 *
 * This NEVER decrypts a credential. It re-wraps dekEnc and writes back dekEnc +
 * kekVersion; apiKeyEnc / apiSecretEnc / passphraseEnc are not read, not
 * written, and stay byte-identical. That is what the envelope buys.
 *
 * Usage:
 *   ROTATE_FROM_VERSION=1 ROTATE_TO_VERSION=2 node scripts/rotate-kek.js --dry-run
 *   ROTATE_FROM_VERSION=1 ROTATE_TO_VERSION=2 node scripts/rotate-kek.js
 *
 * The target KEK comes from the env, via the registry in lib/key-custody:
 *   KEY_CUSTODY_MASTER      -> version 1
 *   KEY_CUSTODY_MASTER_V<n> -> version n
 * Both the old and new master must be present for the run — the old one to
 * unwrap, the new one to re-wrap.
 *
 * Idempotent:  a row already at the target version is SKIPPED, not re-wrapped.
 * Resumable:   state lives in the data (kekVersion), not in this script. Killed
 *              at row 40 of 100? Re-run. It finishes the remaining 60 and skips
 *              the 40 already done. There is no checkpoint file to lose.
 */

import { PrismaClient } from '@prisma/client'
import { rotateRow, availableKekVersions } from '../lib/key-custody'

const prisma = new PrismaClient()

const BATCH_SIZE = 100

function readVersion(envName: string): number {
  const raw = process.env[envName]
  if (!raw) throw new Error(`${envName} is required (e.g. ${envName}=2)`)
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${envName} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const fromVersion = readVersion('ROTATE_FROM_VERSION')
  const toVersion = readVersion('ROTATE_TO_VERSION')

  const held = availableKekVersions()
  for (const v of [fromVersion, toVersion]) {
    if (!held.includes(v)) {
      throw new Error(
        `No KEK held for version ${v}. Versions available: [${held.join(', ')}]. ` +
          `Set ${v === 1 ? 'KEY_CUSTODY_MASTER' : `KEY_CUSTODY_MASTER_V${v}`} and re-run.`,
      )
    }
  }

  console.log(
    `[rotate-kek] ${dryRun ? 'DRY RUN — nothing will be written' : 'LIVE'} | ` +
      `kekVersion ${fromVersion} -> ${toVersion}`,
  )

  const total = await prisma.exchangeKey.count()
  const alreadyDone = await prisma.exchangeKey.count({ where: { kekVersion: toVersion } })
  const pending = await prisma.exchangeKey.count({ where: { kekVersion: fromVersion } })
  const other = total - alreadyDone - pending

  console.log(
    `[rotate-kek] rows: ${total} total | ${pending} at v${fromVersion} (to do) | ` +
      `${alreadyDone} already at v${toVersion} (skip) | ${other} at some other version`,
  )

  if (other > 0) {
    console.log(
      `[rotate-kek] WARNING: ${other} row(s) are at neither v${fromVersion} nor v${toVersion}. ` +
        'They are left untouched — rotate them separately from their own version.',
    )
  }

  if (dryRun) {
    console.log(`[rotate-kek] DRY RUN: would re-wrap ${pending} row(s). Wrote nothing.`)
    return { rotated: 0, skipped: alreadyDone, dryRun: true }
  }

  let rotated = 0
  // Re-query each batch rather than paginating a snapshot: rows leave the
  // `kekVersion: fromVersion` set as we go, so "the next batch still to do" is
  // always a fresh read. This is what makes a resumed run correct.
  for (;;) {
    const batch = await prisma.exchangeKey.findMany({
      where: { kekVersion: fromVersion },
      select: { id: true, dekEnc: true, kekVersion: true },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    })
    if (batch.length === 0) break

    for (const row of batch) {
      const { dekEnc, kekVersion } = rotateRow(row, fromVersion, toVersion)

      // One row, one transaction-free atomic UPDATE. dekEnc and kekVersion move
      // together or not at all; a kill between rows leaves every row either
      // fully at v(from) or fully at v(to), never half-rotated.
      // The guard on kekVersion makes a concurrent second runner a no-op rather
      // than a double-wrap.
      const res = await prisma.exchangeKey.updateMany({
        where: { id: row.id, kekVersion: fromVersion },
        data: { dekEnc, kekVersion },
      })
      if (res.count === 1) {
        rotated++
        console.log(`[rotate-kek] rotated ${row.id} -> v${toVersion} (${rotated}/${pending})`)
      } else {
        console.log(`[rotate-kek] skipped ${row.id} — another runner already moved it`)
      }
    }
  }

  const remaining = await prisma.exchangeKey.count({ where: { kekVersion: fromVersion } })
  console.log(
    `[rotate-kek] done. rotated=${rotated} skipped(already at v${toVersion})=${alreadyDone} ` +
      `remaining at v${fromVersion}=${remaining}`,
  )
  if (remaining > 0) {
    throw new Error(`[rotate-kek] ${remaining} row(s) still at v${fromVersion} — re-run to finish.`)
  }
  return { rotated, skipped: alreadyDone, dryRun: false }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // Message only. The stack of a crypto error can carry buffers; never dump it.
    console.error(`[rotate-kek] FAILED: ${err.message}`)
    await prisma.$disconnect()
    process.exit(1)
  })

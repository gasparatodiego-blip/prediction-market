import { promises as fs } from 'fs'
import path from 'path'

/**
 * Append-only audit trail for the admin venue-credential store.
 *
 * NEVER writes a secret, a plaintext credential, a full api key, a passphrase, or
 * a wallet private key. The only credential-derived value permitted here is
 * `last4` (four characters, already the public fragment surfaced elsewhere).
 *
 * Best-effort by design: auditing must never break a credential operation, so
 * every failure is swallowed. The file is created on first write if missing.
 */

const AUDIT_FILE = path.join(process.cwd(), 'data', 'key-custody-audit.jsonl')

export type AuditAction = 'saved' | 'verified' | 'trading-enabled' | 'revoked'

export interface AuditEntry {
  venue: string
  action: AuditAction
  outcome: string
  last4: string | null
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        venue: entry.venue,
        action: entry.action,
        outcome: entry.outcome,
        last4: entry.last4 ?? null,
      }) + '\n'
    await fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true })
    await fs.appendFile(AUDIT_FILE, line, 'utf8')
  } catch {
    // Best-effort: never throw from the audit path.
  }
}

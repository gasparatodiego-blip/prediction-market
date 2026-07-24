// Type surface for lib/key-custody.js (the CommonJS implementation). Keeps every existing TS consumer
// type-checked with zero edits, while the runtime module is node-requirable by the agents + credsProvider.

/** KEK versions this process can currently unwrap with. */
export function availableKekVersions(): number[]

/** A fresh random 32-byte data key. One per row, never reused across rows. */
export function newDek(): Buffer

/** Wrap a DEK under a KEK (kekVersion bound as GCM AAD). Returns "iv:authTag:ciphertext" base64. */
export function wrapDek(dek: Buffer, version?: number): string

/** Recover a DEK from dekEnc. Throws if the KEK is wrong, absent, or the record is bad. */
export function unwrapDek(dekEnc: string, version: number): Buffer

/** Encrypt one credential field under this row's DEK. Fresh IV per field. */
export function encryptField(plaintext: string, dek: Buffer): string

/** Decrypt one credential field. Throws (identically) on any failure so it can't be used as an oracle. */
export function decryptField(ciphertext: string, dek: Buffer): string

/**
 * The ONLY part of a row rotation reads. A full ExchangeKey row satisfies it structurally, but rotateRow
 * cannot touch apiSecretEnc because it is never handed it.
 */
export interface RotatableRow {
  dekEnc: string
  kekVersion: number
}

/** Re-wrap a row's DEK from one KEK version to another. Does NOT decrypt any credential field. */
export function rotateRow(
  row: RotatableRow,
  oldKekVersion: number,
  newKekVersion: number,
): { dekEnc: string; kekVersion: number }

/** Constant-time equality for two decrypted secrets. */
export function secretsEqual(a: string, b: string): boolean

// lib/caution-chip.ts — the CAUTION-chip display consumer of the guardian's
// K41/K43 removeCautionChip flag (Phase 2 → wired in Phase 3).
//
// The shared suppressor (lib/guardian-suppress) sets row.__guardian.removeCautionChip
// when a red CAUTION alarm chip is CONTRADICTORY: bare (no stated reason, K41) or on a
// row with no real thin-book / stale / unverified risk (K43). The DISPLAY then simply
// does not render that alarm chip.
//
// FOUNDATIONAL PRINCIPLE: display-only. This NEVER edits the verdict TEXT, never rewrites
// a value, never fabricates. It only decides whether the standalone CAUTION *chip* shows.
// Removing the flag (or the guardian not setting it) restores the chip — fully reversible.

export interface CautionGuardianMeta {
  removeCautionChip?: boolean;
}

// True when the guardian asked the display to drop this row's contradictory CAUTION chip.
export function cautionChipRemoved(row: unknown): boolean {
  const g = (row as { __guardian?: CautionGuardianMeta } | null | undefined)?.__guardian;
  return g?.removeCautionChip === true;
}

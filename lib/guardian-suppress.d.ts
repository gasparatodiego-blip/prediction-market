// Types for the shared honest-engine suppressor (lib/guardian-suppress.js).
// Consumed by the TS serve routes (app/api/*) AND agent26 (plain JS) so the site
// suppresses exactly what the auditor alerts on — ONE shared suppressor, rules A–E.

export type GuardianSection =
  | 'funding' | 'perp-spot' | 'usdc' | 'basis' | 'rewards' | 'sports' | 'prediction';

export type GuardianAction =
  | 'hide' | 'downgrade' | 'suppress-value' | 'relabel' | 'correct-min' | 'flag';

export interface GuardianDecision {
  rule: string;
  action: GuardianAction;
  reason: string;
  fields?: string[];
  label?: string;
  verifyStatus?: string;
  value?: number;
  path?: string;
  set?: Record<string, unknown>;
  downgradeCashable?: boolean;
  // Phase 2 (rules F–K) display-meta carriers:
  runRate?: boolean;          // G28/G29 — annualized shown as a run-rate, not a promise
  signalOnly?: boolean;       // K42 — reference/mid lane forced to signal-only
  removeCautionChip?: boolean; // K41/K43 — drop the contradictory red alarm chip
  severity?: 'hide' | 'value' | 'soft';
}

// Attached to a suppressed row's DISPLAY copy. The producer's source files are never
// written; every changed field's pre-suppression value is kept in `original`.
export interface GuardianMeta {
  actions: Array<{ rule: string; action: GuardianAction; reason: string }>;
  original: Record<string, unknown>;
  suppressedFields: string[];
  label?: string;
  downgraded?: boolean;
  corrected?: boolean;
  downgradeCashable?: boolean;
  flag?: boolean;
  flags?: string[];
  // Phase 2 (rules F–K):
  runRate?: boolean;          // G28/G29 — attach "run-rate, not guaranteed" caveat
  signalOnly?: boolean;       // K42 — reference/mid lane, never cashable
  removeCautionChip?: boolean; // K41/K43 — contradictory alarm chip removed
}

export interface GuardianSuppression {
  section: GuardianSection;
  rowId: string;
  rule: string;
  action: GuardianAction;
  reason: string;
  timestamp: number;
}

export interface GuardianCritical {
  type: 'mass-suppress' | 'paid-leak' | 'count-mismatch';
  section: GuardianSection | 'paid-gating';
  wouldHide: number;
  total: number;
  reason: string;
}

export interface GuardianZeroState {
  empty: boolean;
  reason: 'no-data' | 'redacted';
}

export interface GuardianCtx {
  now?: number;
  nowFn?: () => number;
  log?: (msg: string) => void;
  directiveFor?: Record<string, any>;
  noDirectives?: boolean;
  deadSet?: Set<string>;
  priceMedian?: number;
  categoryMedian?: number;
  // Phase 2 (rules F–K):
  emptyReason?: 'no-data' | 'redacted'; // J37/J38 — why the tab is empty (route knows isPaid)
  claimedCashable?: number;             // J39 — header's claimed cashable count to reconcile
  // Phase 3 (rules L–N):
  unclassified?: Set<string>;           // N50 — `${section}:${id}` rows the auditor flags unclassified ⇒ suppress
}

export interface GuardianResult<T> {
  rows: T[];
  suppressions: GuardianSuppression[];
  critical: GuardianCritical | null;      // the mass-suppression guardrail (rule, backward-compatible)
  zeroState?: GuardianZeroState | null;   // J37/J38 — calm zero-state hint
  criticals?: GuardianCritical[];         // J39 (and future) rule-driven criticals
}

export interface GuardianRedactionResult {
  leaks: string[];
  critical: GuardianCritical | null;
}

// H (rules 31–33): paid-gating leak backstop. Nulls any sensitive field (paid-gating
// path grammar) that survived redaction on a free-tier payload; never fabricates. No-op
// for paid. Mutates `payload` in place; returns the leaked paths + a CRITICAL if any.
export declare function assertRedacted(
  payload: unknown,
  sensitivePaths: string[],
  opts?: { log?: (msg: string) => void },
): GuardianRedactionResult;

export declare function applyGuardian<T>(
  section: GuardianSection,
  rows: T[] | null | undefined,
  ctx?: GuardianCtx,
): GuardianResult<T>;

export declare function inspectRow(section: GuardianSection, row: any, ctx?: GuardianCtx): GuardianDecision[];
export declare function applyDecision(row: any, decision: GuardianDecision): void;
export declare function rowId(section: GuardianSection, row: any): string;
export declare function impliedApr(section: GuardianSection, row: any): number | null;
export declare function median(nums: Array<number | null | undefined>): number | null;
export declare function readDirectives(now: number, file?: string): Record<string, any>;
export declare function getPath(obj: any, path: string): unknown;
export declare function setPath(obj: any, path: string, val: unknown): boolean;

export declare const SECTION_CFG: Record<string, any>;
export declare const LABELS: Record<string, string>;
export declare const APY_HARD_MAX: number;
export declare const APY_IMPOSSIBLE: number;
export declare const CATEGORY_MULT: number;
export declare const MIN_DEPTH_USD: number;
export declare const MASS_SUPPRESS_FRAC: number;
export declare const MASS_SUPPRESS_MIN: number;
export declare const STALE_MINUTES_MAX: number;
export declare const CASHABLE_SWING: number;
export declare const CROSS_SURFACE_TOL: number;
export declare const MIN_ROUNDTRIP_FEE_FRAC: number;
export declare const RUN_RATE_APR_MIN: number;
export declare const IMPOSSIBLE_BREAKEVEN: number;
export declare const REFERENCE_ONLY_VENUES: string[];
export declare const SPIKE_MULT: number;
export declare const UNIT_SUSPECT_LO: number;
export declare const UNIT_SUSPECT_HI: number;
export declare const DIRECTIVES_FILE: string;

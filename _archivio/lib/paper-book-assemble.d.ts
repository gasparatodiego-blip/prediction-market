// Types for lib/paper-book-assemble.js (SSOT paper-book aggregation).
// Structural only — the JS module is the source of truth for the math.

export interface PaperBookMeta {
  entryAsOf: string | null;
  updatedAt: string | null;
  simDays: number | null;
  simEndsAt: string | null;
  notionalUsd: number | null;
  dayIndex: number;
}

export interface PaperBookHeadline {
  executablePnlUsd: number | null;
  executablePnlHas: boolean;
  thinPnlUsd: number | null;
  thinOpen: number;
  ticketCount: number;
  ticketSizeUsd: number | null;
  totalNotionalUsd: number | null;
  openTicketCountAll: number;
  openNotionalUsdAll: number | null;
}

export interface PaperBookPosition {
  id: string;
  category: string;
  label: string;
  status: string;
  metricKind: string;
  thin: boolean;
  value: number | null;
  entry: Record<string, unknown> | null;
  lastMark: Record<string, unknown> | null;
  marks: Array<Record<string, unknown>>;
  contractKey: string | null;
  fundingCursorT: number | null;
  cumFundingUsd: number | null;
}

export interface PaperBookStrategy {
  key: string;
  label: string;
  metric: string | null;
  chip: string;
  open: number;
  matured: number;
  execOpen: number;
  execNotionalUsd: number | null;
  execPnlUsd: number | null;
  thinOpen: number;
  thinPnlUsd: number | null;
  positions: PaperBookPosition[];
}

export interface PaperBookAssembled {
  meta: PaperBookMeta;
  headline: PaperBookHeadline;
  equityCurve: Array<{ asOf: string; netUsd: number | null }>;
  strategies: PaperBookStrategy[];
  copy: {
    sleeveCount: number;
    openLegs: number;
    pnlUsd: number | null;
    sleeves: Array<Record<string, unknown>>;
  };
  excluded: Array<Record<string, unknown>>;
}

export function assemblePaperBook(
  store: unknown,
  opts?: { nowMs?: number },
): PaperBookAssembled;
export function tradeValue(t: unknown): number | null;
export function isThin(t: unknown): boolean;
export const THIN_VERDICT: RegExp;
export function equityCurve(trades: unknown[]): Array<{ asOf: string; netUsd: number | null }>;

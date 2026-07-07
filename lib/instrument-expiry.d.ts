export interface DatedRow {
  expiry?: string;
  contract?: string;
  instrument?: string;
  name?: string;
  [k: string]: unknown;
}

export declare const MONTH_IDX: Record<string, number>;
export declare function parseInstrumentExpiryMs(name: unknown): number | null;
export declare function rowExpiryMs(row: DatedRow | null | undefined): number | null;
export declare function isExpired(row: DatedRow | null | undefined, now?: number): boolean;
export declare function isLive(row: DatedRow | null | undefined, now?: number): boolean;

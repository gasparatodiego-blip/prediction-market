export declare const PUSD: string;
export declare const USDCE: string;
export declare const CTF: string;
export interface PolyExchange { key: string; name: string; addr: string }
export declare const EXCHANGES: readonly PolyExchange[];
export declare const ORACLE_NAMES: Readonly<Record<string, string>>;
export declare function oracleName(addr: string | null | undefined): string | null;
export declare const DEFAULT_RPC: string;

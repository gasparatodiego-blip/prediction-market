export declare const RWA_COMMODITY: Record<string, { label: string; aster: string; extended: string }>;
export declare const RWA_KEYS: string[];
export declare const RWA_VENUES: string[];
export declare function isRwaKey(coin: string): boolean;
export declare function rwaCanonicalFor(venue: string, rawSymbol: string): string | null;
export declare function rwaVenueSymbol(venue: string, canonicalKey: string): string | null;
export declare function rwaLabel(canonicalKey: string): string;

/** Il tetto per mercato (YES+NO sommati), condiviso da tutti e quattro i percorsi che lo consumano:
 *  pianificatore, motore di piazzamento, rimpiazzo di una gamba, punteggio di rischio.
 *  Vedi lib/rewards/concentration.js. */

/** Il tetto FISSO in dollari su un singolo mercato, YES+NO sommati. Dal 9 agosto 2026 non è più una
 *  frazione del capitale: quando il capitale cresce si usano più mercati, non size più grandi. */
export declare const MARKET_CAP_FIXED_USD: number;

/** Il tetto in dollari. Non restituisce MAI null — a valle null varrebbe «nessun tetto» — e si clampa
 *  al capitale quando questo è leggibile: può solo stringere, mai concedere più di quanto ci sia. */
export declare function capPerMarketUsd(capitalUsd?: number | null): number;

/** Quanti mercati servono per impegnare `capitalUsd` a questo tetto: `ceil(capitale / tetto)`.
 *  null quando il capitale non è leggibile. */
export declare function mercatiNecessari(capitalUsd?: number | null): number | null;

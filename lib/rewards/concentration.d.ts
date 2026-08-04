/** Il tetto di concentrazione per singolo mercato, condiviso fra il pannello «Ottimizza» e il
 *  riallocatore periodico. Vedi lib/rewards/concentration.js. */

/** Frazione massima del capitale su un singolo mercato. */
export declare const CONCENTRATION_CAP_FRAC: number;

/** Il tetto in dollari per un dato capitale; null quando il capitale non è utilizzabile (= nessun tetto). */
export declare function capPerMarketUsd(capitalUsd: number | null | undefined, frac?: number): number | null;

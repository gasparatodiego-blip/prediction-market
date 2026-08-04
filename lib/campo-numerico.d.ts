/** Il numero DIGITATO, o null se il campo è vuoto/non interpretabile. Mai 0 per ripiego, mai NaN.
 *  Vedi lib/campo-numerico.js: `Number('')` vale 0, ed è da lì che nasceva il guard che accusava un
 *  modulo vuoto di tre errori. */
export declare function numeroDigitato(s: unknown): number | null;

/** Come sopra, ma null anche per uno zero digitato: per i campi in cui 0 non è un valore usabile. */
export declare function digitatoEPositivo(s: unknown): number | null;

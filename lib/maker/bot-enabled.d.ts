// Tipi per lib/maker/bot-enabled.js — L'INTERRUTTORE AVVIA/FERMA, l'unico del sistema.
//
// Serve perché il modulo è JS e TypeScript, in assenza di questi tipi, deduce le firme dai valori di
// default: `reason = null` diventerebbe il TIPO `null`, e passare un motivo — che è tutto il punto di
// avere un registro di chi ha premuto cosa e perché — sarebbe un errore di compilazione.

/** Un mercato aperto dal bot dall'ultimo AVVIA. Registro, non quota: non limita più niente. */
export interface MercatoDallAvvio {
  marketId: string;
  at: number;
  atIso: string;
}

export interface StatoBot {
  v: 1;
  /** L'unica cosa che autorizza un piazzamento automatico. Falsa per default e a ogni dubbio. */
  enabled: boolean;
  /** Istante dell'ultima commutazione, epoch ms. NON è l'istante della lettura. */
  at: number | null;
  atIso: string | null;
  by: string | null;
  reason: string | null;
  mercatiDallAvvio: MercatoDallAvvio[];
  /** false quando il flag non è stato letto: file assente, illeggibile o malformato ⇒ `enabled` è false. */
  leggibile: boolean;
  /** Perché è fermo, quando non lo è per scelta. null se lo stato è stato letto senza problemi. */
  motivo: string | null;
}

/**
 * Il registro delle aperture dall'ultimo AVVIA. **Osservazione pura**: dal 9 agosto 2026 non esiste
 * più un tetto giornaliero, e quante aperture nuove siano concesse adesso lo dice
 * `utilizzo-capitale.aperturaNuoviMercati` guardando l'obiettivo di utilizzo del capitale.
 */
export interface ApertureDallAvvio {
  /** Mercati DISTINTI aperti dal bot dall'ultimo AVVIA. */
  aperti: number;
  mercati: string[];
  dallAvvio: number | null;
  dallAvvioIso: string | null;
  oreDallAvvio: number | null;
  motivo: string;
}

export interface EsitoImposta {
  ok: boolean;
  /** Presente solo quando `ok` è false: la scrittura NON è avvenuta e l'interruttore non è cambiato. */
  motivo?: string;
  prima?: boolean;
  ora?: boolean;
  stato?: Omit<StatoBot, 'leggibile' | 'motivo'>;
}

export interface EsitoRegistra {
  ok: boolean;
  giaPresente?: boolean;
  aperti?: number;
  motivo?: string;
}

/** Non solleva mai: qualunque problema di lettura è `enabled:false` col motivo. */
export declare function statoBot(args?: { file?: string }): StatoBot;

/** Il bot può aprire posizioni nuove adesso? */
export declare function botAttivo(args?: { file?: string }): boolean;

/** Commuta l'interruttore. Accendere azzera il registro delle aperture. */
export declare function impostaBot(args: {
  enabled: boolean;
  by?: string;
  reason?: string | null;
  file?: string;
  now?: number;
}): EsitoImposta;

export declare function apertureDallAvvio(args?: { file?: string; now?: number }): ApertureDallAvvio;

/** Idempotente sul marketId: due gambe sullo stesso mercato sono un mercato solo. */
export declare function registraMercatoAperto(args: {
  marketId: string;
  file?: string;
  now?: number;
}): EsitoRegistra;

export declare const FILE: string;

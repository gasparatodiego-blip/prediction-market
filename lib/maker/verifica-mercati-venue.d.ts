/** Verifica al venue dei mercati che stanno per ricevere ordini. Vedi lib/maker/verifica-mercati-venue.js. */

export type VenueRecord = {
  readable: boolean; error?: string | null;
  closed?: boolean; active?: boolean | null; acceptingOrders?: boolean | null;
  rewardsDailyRate?: number | null; maxSpreadCents?: number | null;
  minSizeShares?: number | null; endDate?: string | null;
};
export type Bocciato = { marketId: string; stato: string; motivo: string };

export declare function verificaMercatiAlVenue(
  args: { rows?: { marketId: string }[]; poolAlPiano?: Record<string, number>; nowMs?: number },
  deps?: { readVenue?: (a: { marketId: string }) => Promise<VenueRecord> },
): Promise<{ validi: string[]; bocciati: Bocciato[]; illeggibili: Bocciato[]; verdetti: any[] }>;

export declare function filtraRighe<T extends { marketId: string }>(rows: T[], bocciati: Bocciato[]): T[];
export declare function leggiVenueClob(a: { marketId: string }): Promise<VenueRecord>;

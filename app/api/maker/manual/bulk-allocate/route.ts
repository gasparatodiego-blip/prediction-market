import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runBulkAllocation } from '@/lib/maker/bulk-allocate';
import { runAllocationReset } from '@/lib/maker/allocation-reset';
import { diagnoseExposure } from '@/lib/maker/manual-reset';
import { listManualOrders, cancelManualOrder } from '@/lib/maker/manual-order';
import { readAutoRepriceConfig, setAutoReprice } from '@/lib/maker/auto-reprice-config';
import { readTrackingConfig, setTracking } from '@/lib/maker/mm-tracking-config';
import { setManualMode } from '@/lib/maker/manual-mode';
import { appendMakerAudit } from '@/lib/venues/polymarket-clob-maker/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/bulk-allocate — place every row of an allocation plan, in sequence.
 *
 * It is a loop over the SAME placeManualOrder every hand order uses: no second placement path, no extra
 * venue surface, and every order lands under the same watcher management afterwards (mid chase, band
 * ceiling, GTD renewal, reconciliation).
 *
 * WHAT IT ADDS is the CUMULATIVE cap. Ten orders each individually under the per-order cap can still add
 * up past the account's open-notional ceiling, and the per-order gate cannot see that. So the run tracks
 * its own running total — starting from exposure ALREADY open, not from zero — and STOPS cleanly the
 * moment the next row would cross it, rather than attempting it and letting a gate refuse mid-sequence.
 * It stops instead of skipping ahead to a smaller row that would still fit: silently reordering an
 * allocation makes it a different allocation from the one that was confirmed.
 *
 * `preview: true` runs the whole sequence WITHOUT placing anything — same cap arithmetic, same stop
 * point, nothing sent. That is what backs the confirmation summary.
 *
 * ─── DAL 3 AGOSTO 2026: È UN RESET, NON UNA SOMMA ───────────────────────────────────────────────────
 * Prima questa route faceva solo la fase di piazzamento, e il registro dei mercati abilitati è additivo
 * per costruzione: i mercati di sessioni passate restavano nell'allowlist per sempre. Misurato: sei
 * mercati abilitati, cinque dei quali finestre BTC da cinque minuti chiuse da un giorno, con l'operatore
 * convinto di averne zero.
 *
 * Adesso `preview:false` passa da lib/maker/allocation-reset.js, che porta lo stato finale a essere
 * ESATTAMENTE il piano: cancella gli ordini a riposo sui mercati gestiti, spegne tracking e allowlist,
 * riaccende solo i mercati del piano, poi piazza — con lo STESSO runBulkAllocation di prima, che resta
 * l'unica strada che invii ordini.
 *
 * `preview:true` continua a non toccare NULLA, e in più adesso dice anche cosa verrebbe cancellato e
 * spento: da quando il tap finale cancella ordini veri, l'anteprima deve mostrarlo prima del tap.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
const rowSchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  book: z.enum(['yes', 'no']),
  side: z.enum(['BUY', 'SELL']).optional(),
  price: z.number().finite().gt(0).lt(1),
  size: z.number().finite().gt(0).max(100_000),
  title: z.string().max(300).optional(),
});
const bodySchema = z.object({
  rows: z.array(rowSchema).min(1).max(50),
  preview: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // The running total starts from what is ALREADY open, read from the same source the cap gate uses.
    const diag = diagnoseExposure({});
    const preview = parsed.data.preview === true;

    const reset = await runAllocationReset(
      { rows: parsed.data.rows, dryRunOnly: preview },
      {
        readEnabled: () => readAutoRepriceConfig({}).enabledMarketIds || [],
        readTracking: () => readTrackingConfig().marketIds || [],
        listOrders: ({ marketId }: { marketId: string }) => listManualOrders({ marketId }),
        // La corsia cancel-only: signer di solo indirizzo, strutturalmente incapace di piazzare.
        // La sorgente è `manual-ui` e non una nuova: è vero — è l'operatore che agisce col bottone — e
        // MANUAL_SOURCES è un'allowlist di sicurezza che non vale la pena allargare per un'etichetta.
        // L'attribuzione precisa c'è comunque: ogni cancellazione finisce nell'audit del reset con
        // `op:'allocation-reset'`, marketId, orderId, prezzo e size.
        cancelOrder: ({ orderId, marketId }: { orderId: string; marketId: string }) =>
          cancelManualOrder({ orderId, marketId }, 'manual-ui'),
        setTrackingOff: ({ marketId, reason }: { marketId: string; reason: string }) =>
          setTracking({ marketId, enabled: false, by: 'operatore · reset allocazione', reason }),
        setEnabled: ({ marketId, enabled, reason }: { marketId: string; enabled: boolean; reason: string }) =>
          setAutoReprice({ scope: 'market', marketId, enabled, by: 'operatore · reset allocazione', reason }),
        setManual: ({ marketId, manual, reason }: { marketId: string; manual: boolean; reason: string }) =>
          setManualMode({ marketId, manual, by: 'operatore · reset allocazione', reason }),
        // La fase 4 è il ciclo di piazzamento di SEMPRE: stesso cap cumulativo, stesso rate limit,
        // stessi gate per riga. Il reset non apre una seconda strada verso il venue.
        placeBulk: ({ rows, dryRunOnly }: { rows: unknown[]; dryRunOnly: boolean }) =>
          runBulkAllocation(
            { rows: rows as never, dryRunOnly },
            {
              openNotionalUsd: diag.readable ? (diag.openNotionalUsd || 0) : 0,
              // Il ritiro di una gamba rimasta sola quando la sua controparte viene rifiutata. Le righe
              // che il pannello manda oggi non sono accoppiate, quindi non scatta mai; è cablata lo
              // stesso perché il giorno in cui il pannello manderà coppie, l'assenza di questa riga
              // sarebbe un'esposizione asimmetrica invece di un ripristino.
              cancelOrder: ({ orderId, marketId }: { orderId: string; marketId: string }) =>
                cancelManualOrder({ orderId, marketId }, 'manual-ui'),
            },
          ),
        audit: (rec: Record<string, unknown>) => { try { appendMakerAudit(rec); } catch { /* l'audit non blocca */ } },
      },
    );

    // Il referto del piazzamento resta in cima alla risposta, perché è la forma che il pannello legge
    // già oggi (placed/refused/skipped/results). Il resto del reset viaggia accanto, non al posto suo.
    const place = reset.piazzamento || { ok: reset.ok, placed: 0, refused: 0, skipped: 0, results: [], totals: null };
    return NextResponse.json({
      ...place,
      ok: reset.ok && place.ok !== false,
      reset: {
        stoppedBy: reset.stoppedBy, reason: reset.reason, preview: reset.preview,
        inventario: reset.inventario, cancellazione: reset.cancellazione,
        spegnimento: reset.spegnimento, accensione: reset.accensione,
        log: reset.log,
      },
      openBefore: diag.openNotionalUsd,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, at: new Date().toISOString(), results: [], reason: 'la sequenza è fallita prima di completarsi' },
      { status: 500 },
    );
  }
}

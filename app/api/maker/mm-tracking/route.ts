import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
import { z } from 'zod';
import { readTrackingConfig, setTracking, LIMITS } from '@/lib/maker/mm-tracking-config';
import { planQuotes } from '@/lib/maker/mm-quote-math';
import { resolveMarketRules, listManualOrders, cancelManualOrder } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/mm-tracking — IL TOGGLE CHE AUTORIZZA IL MOTORE, e lo stato di cio' che sta facendo.
 *
 * QUESTO E' L'UNICO PUNTO IN CUI SI CONCEDE A UN AUTOMATISMO DI PIAZZARE ORDINI REALI SENZA UNA
 * CONFERMA PER ORDINE. Ovunque altro in questo progetto un ordine vero costa due tocchi espliciti; qui
 * i due tocchi comprano una DELEGA CONTINUATA su un mercato solo, e per questo:
 *   · il flusso resta a due passi (`preview:true` non scrive nulla, `preview:false` scrive);
 *   · ogni parametro e' obbligatorio — nessun default, perche' un default significherebbe quotare con
 *     numeri che l'operatore non ha scelto;
 *   · l'anteprima mostra DOVE finirebbero i due ordini adesso, coi prezzi veri del venue;
 *   · ogni accensione e spegnimento finisce in un audit append-only con chi e perche'.
 *
 * SPEGNERE E' SEMPRE PERMESSO, anche con lo stato illeggibile: e' la direzione sicura.
 *
 * GET  → chi e' in tracking, con la configurazione e lo stato vivo pubblicato dal motore.
 * POST → accende/spegne. Con `cancelOrders:true` allo spegnimento, cancella anche gli ordini a riposo.
 */

const STATE_FILE = '/tmp/maker-mm-tracking-state.json';

const bodySchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  preview: z.boolean().optional(),          // default true — scrivere richiede preview:false esplicito
  offsetCents: z.number().finite().optional(),
  minMoveCents: z.number().finite().optional(),
  sizeShares: z.number().finite().optional(),
  // Allo spegnimento: cancellare gli ordini a riposo, oppure lasciarli scadere per GTD. Nessun default
  // nascosto — la route lo pretende esplicito e l'anteprima dice cosa succederebbe in entrambi i casi.
  cancelOrders: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

function readState(): unknown {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

export async function GET() {
  const cfg = readTrackingConfig();
  return NextResponse.json({
    ok: true, at: new Date().toISOString(),
    readable: cfg.readable, error: cfg.error,
    limits: LIMITS,
    count: cfg.marketIds.length,
    markets: cfg.marketIds.map((id) => cfg.markets[id]),
    // Cosa il motore sta facendo ADESSO. `null` = agent40 non ha ancora pubblicato uno stato, il che
    // significa «non lo sappiamo», non «non sta facendo niente».
    engine: readState(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'corpo non JSON' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  }
  const { marketId, enabled, offsetCents, minMoveCents, sizeShares, cancelOrders, reason } = parsed.data;
  const preview = parsed.data.preview !== false;

  try {
    // ── SPEGNIMENTO ───────────────────────────────────────────────────────────────────────────────
    if (!enabled) {
      let resting: Array<{ orderId: string | null; price: number | null; size: number | null }> = [];
      try {
        const l = await listManualOrders({ marketId });
        if (l && l.ok) resting = (l.orders || []).map((o: { orderId: string | null; price: number | null; sizeRemaining: number | null }) => ({ orderId: o.orderId, price: o.price, size: o.sizeRemaining }));
      } catch { /* la lista non e' una precondizione dello spegnimento */ }

      if (preview) {
        return NextResponse.json({
          ok: true, preview: true, action: 'tracking-off', marketId,
          restingOrders: resting,
          note: resting.length
            ? `Il tracking verrebbe spento. Ci sono ${resting.length} ordini a riposo su questo mercato: scegli se cancellarli subito oppure lasciarli scadere per GTD (il venue li ritira comunque entro la finestra).`
            : 'Il tracking verrebbe spento. Non ci sono ordini a riposo su questo mercato.',
        });
      }

      const off = setTracking({ marketId, enabled: false, reason: reason ?? 'spento dall operatore' });
      if (!off.ok) return NextResponse.json({ ok: false, error: off.error }, { status: 500 });

      const cancelled: Array<{ orderId: string | null; ok: boolean; reason: string | null }> = [];
      if (cancelOrders === true) {
        for (const o of resting) {
          if (!o.orderId) continue;
          try {
            const c = await cancelManualOrder({ orderId: o.orderId, marketId }, 'mm-tracking');
            cancelled.push({ orderId: o.orderId, ok: c.ok !== false, reason: c.reason ?? null });
          } catch (e) { cancelled.push({ orderId: o.orderId, ok: false, reason: (e as Error).message }); }
        }
      }
      return NextResponse.json({
        ok: true, preview: false, action: 'tracking-off', marketId,
        cancelledOrders: cancelOrders === true, cancelled,
        note: cancelOrders === true
          ? `Tracking spento e ${cancelled.filter((c) => c.ok).length}/${cancelled.length} ordini cancellati sul venue.`
          : 'Tracking spento. Gli ordini a riposo NON sono stati toccati: scadranno da soli per GTD, perche nulla li rinnova piu.',
      });
    }

    // ── ACCENSIONE ────────────────────────────────────────────────────────────────────────────────
    if (offsetCents == null || minMoveCents == null || sizeShares == null) {
      return NextResponse.json({ ok: false, error: 'offsetCents, minMoveCents e sizeShares sono obbligatori per accendere: qui non esistono default' }, { status: 400 });
    }

    const rules = resolveMarketRules(marketId);
    if (!rules.readable) {
      return NextResponse.json({
        ok: false, error: `regole di venue non leggibili per questo mercato (mancano: ${rules.missing.join(', ')}) — non accendo un motore automatico su regole che non so leggere`,
      }, { status: 409 });
    }
    const plan = planQuotes({ mid: rules.mid, offsetCents, tick: rules.tick, bandRadiusCents: rules.bandRadiusCents });

    if (preview) {
      return NextResponse.json({
        ok: true, preview: true, action: 'tracking-on', marketId,
        rules: { mid: rules.mid, tick: rules.tick, minSize: rules.minSize, bandRadiusCents: rules.bandRadiusCents, midSource: rules.midSource, midAgeSec: rules.midAgeSec },
        plan,
        note: 'Anteprima: NIENTE e stato scritto e nessun ordine e stato piazzato. Questi sono i due livelli dove il motore quoterebbe con il mid di adesso.',
      });
    }

    const on = setTracking({ marketId, enabled: true, offsetCents, minMoveCents, sizeShares, by: 'operatore · pannello ordine', reason: reason ?? null });
    if (!on.ok) return NextResponse.json({ ok: false, error: on.error }, { status: 400 });
    return NextResponse.json({
      ok: true, preview: false, action: 'tracking-on', marketId, record: on.record, plan,
      note: 'Tracking ATTIVO. Da adesso il motore quota entrambi i lati e li insegue quando il mid si muove oltre la soglia, senza chiedere conferma ordine per ordine. Si spegne dallo stesso pulsante.',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

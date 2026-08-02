import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { placeManualOrder } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/order — place ONE order BY HAND.
 *
 * This is the only endpoint in the manual lane that can reach POST /order, and it adds no authority of
 * its own. Every gate the automatic engine runs, runs here, in this order — each one names itself, so a
 * refusal is never generic:
 *
 *   1. manual ownership   the market must be in manual mode, i.e. agent35 is provably standing off it
 *   2. venue rules        tick / scoring mid / band / min_incentive_size must be READABLE (fail closed)
 *   3. the shared guard   lib/maker/venue-rules.validateQuote — the identical function the board's band
 *                         warning calls; on-tick, at or above min size, inside the price range
 *
 * LA BANDA REWARD NON È PIÙ UN DIVIETO SU QUESTA CORSIA. Un prezzo fuori dalla banda premiante non viola
 * nessuna regola del venue: l'ordine viene accettato e riposa, semplicemente non matura reward. Prima
 * veniva rifiutato insieme agli off-tick, con il risultato che il pannello mostrava un avviso e poi il
 * server bloccava comunque — cioè l'avviso non era un avviso. Ora il chiamante che ha MOSTRATO quel costo
 * a chi decide lo dichiara con `acknowledgeOutOfBand`, e il codice OUT_OF_BAND scende da bloccante a
 * dichiarato (registrato nell'audit come `bandAdvisory`, mai taciuto). Il tick resta un blocco pieno: quello
 * sì è una regola del venue, e un prezzo fuori griglia verrebbe rifiutato dall'exchange comunque.
 *   4. the per-order cap  the MINIMUM of data/safety-risk-limits.json maxOrderNotionalUsd and the
 *                         adapter's live-min cap — never a hardcoded number, never from the request
 *   5. the GLOBAL kill    data/safety-kill-switch.json, re-read now, fail-closed
 *   then the adapter re-runs its own chain independently: venue rules, live-min cap, the single-market
 *   pin, kill, venue allowlist, server-side risk limits, SDK/mode/funding, the CLOB order version, and
 *   finally the exchange's own validateOrder() via eth_call.
 *
 * validateOrder IS NEVER BYPASSED ON A SEND. When an earlier gate refuses, the refusal happens before any
 * key is decrypted — stricter still, not weaker.
 *
 * DEFAULTS CLOSED. `MANUAL_ORDER_PLACEMENT` governs this path and anything other than the exact string
 * 'send' is dry-run: build, sign, ask CTFExchangeV2.validateOrder(), report exactly what would have gone,
 * and drop it. It deliberately does NOT read MAKER_PLACEMENT — the engine's send switch must not arm this
 * panel by side effect, nor the reverse.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */

const bodySchema = z.object({
  marketId: z.string().trim().min(1).max(200).optional(),
  book: z.enum(['yes', 'no']),
  price: z.number().finite().gt(0).lt(1),
  size: z.number().finite().gt(0).max(100_000),
  // 0 is a MEANINGFUL value: it means GTC — rest with NO venue expiry, to be moved only when the mid
  // pushes the order out of the reward band (see lib/maker/auto-reprice.js). It is not the same as
  // omitting the field: omitting it lets the server decide from the market's auto-reprice switch
  // (GTC when on, the usual 180s GTD when off), which is what the panel does.
  ttlSeconds: z.number().int().min(0).max(86_400).optional(),
  note: z.string().trim().max(280).optional(),
  // LA PROMESSA DI FRESCHEZZA. Chi ha mostrato all'operatore un prezzo dichiarandolo «live» lo scrive
  // qui, e il gate `stale-book` lo tiene alla promessa: la banda dev'essere giudicata contro un mid che
  // viene davvero dal book live e che sia piu' giovane di questi millisecondi. Assente ⇒ nessun requisito,
  // perche' un chiamante che non ha promesso niente non va bloccato da un vincolo che non gli e' stato
  // posto e che su un mercato fuori dal feed non potrebbe soddisfare.
  requireFreshBookMs: z.number().int().min(1000).max(120_000).optional(),
  // «Il costo è stato mostrato a chi decide, e ha scelto lo stesso.» Declassa il SOLO codice OUT_OF_BAND
  // da bloccante a dichiarato. Assente ⇒ false ⇒ comportamento severo di prima, perché un chiamante che
  // non ha mostrato nulla non può acconsentire per conto di nessuno.
  acknowledgeOutOfBand: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, gate: 'invalid-body', error: 'invalid body', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { acknowledgeOutOfBand, ...order } = parsed.data;
    const res = await placeManualOrder({ ...order, allowOutOfBand: acknowledgeOutOfBand === true });
    // A refused order is a 200 with ok:false and its gate — the request was well-formed and the system
    // answered it. Reserve non-2xx for a request or server that failed, so the panel can always render
    // the gate that refused rather than an opaque HTTP error.
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(
      { ok: false, sent: null, ambiguous: true, error: (e as Error).message, at: new Date().toISOString() },
      { status: 500 },
    );
  }
}

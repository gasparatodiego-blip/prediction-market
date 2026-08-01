import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { acquireLease, releaseLease, readActiveLeases, LEASE_TTL_MS, LEASE_RENEW_MS, LEASE_CAP } from '@/lib/maker/live-lease';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/live-lease — «tienimi sottoscritto al book di questo mercato finché lo sto guardando».
 *
 * COSA FA E COSA NON FA. Scrive UNA riga in data/maker-live-leases.json, che agent34 legge per decidere a
 * cosa sottoscriversi. Non abilita niente, non autorizza niente, non tocca la lista dei mercati abilitati
 * né la gestione manuale né il kill-switch: il canale market del CLOB è pubblico, senza chiavi, e non ha
 * nessun percorso d'ordine. Un permesso qui vuol dire «guarda questo prezzo». Nient'altro.
 *
 * PER QUESTO NON HA IL DOPPIO PASSO. I due passi esistono dove un tocco cambia cosa il sistema può FARE
 * (abilitare un mercato, piazzare un ordine). Qui il tocco cambia solo cosa il sistema GUARDA, e
 * pretendere una conferma per guardare un prezzo trasformerebbe un'abitudine di conferma in un
 * riflesso — che è esattamente come si finisce per premere «sì» sulla cosa che contava.
 *
 * POST { marketId, action: 'acquire' | 'release' }
 *   acquire  → prende O rinnova. Il pannello manda lo stesso messaggio all'apertura e a ogni battito.
 *   release  → libera subito lo slot. È un'ottimizzazione: un permesso non rilasciato scade da solo.
 *
 * GET → i permessi attivi, per diagnosi.
 */

const bodySchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  action: z.enum(['acquire', 'release']),
  by: z.string().trim().max(120).optional(),
});

export async function GET() {
  const now = Date.now();
  const leases = readActiveLeases({ now });
  return NextResponse.json({
    ok: true, at: new Date(now).toISOString(),
    ttlMs: LEASE_TTL_MS, renewEveryMs: LEASE_RENEW_MS, cap: LEASE_CAP,
    count: leases.length, leases,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'corpo non JSON' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const { marketId, action } = parsed.data;
  try {
    if (action === 'release') {
      const r = releaseLease(marketId);
      return NextResponse.json({ ...r, action, ttlMs: LEASE_TTL_MS, renewEveryMs: LEASE_RENEW_MS },
        { status: r.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store, max-age=0' } });
    }
    const r = acquireLease(marketId, { by: parsed.data.by ?? 'pannello ordine' });
    return NextResponse.json({ ...r, action, ttlMs: LEASE_TTL_MS, renewEveryMs: LEASE_RENEW_MS, cap: LEASE_CAP },
      { status: r.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
